import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  CloudOff,
  ExternalLink,
  Gauge,
  Headphones,
  KeyRound,
  LoaderCircle,
  LogOut,
  Pause,
  Play,
  RotateCcw,
  Search,
  Settings2,
  SkipBack,
  SkipForward,
  Volume2,
  X,
} from 'lucide-react'
import './App.css'

type LibraryLocation = '' | 'new' | 'later' | 'shortlist' | 'archive'

type Article = {
  id: string
  url: string
  source_url?: string | null
  title: string
  author?: string | null
  source?: string | null
  site_name?: string | null
  category: string
  location: string
  word_count?: number | null
  reading_time?: string | null
  listening_time?: string | null
  summary?: string | null
  image_url?: string | null
  language?: string | null
  saved_at?: string | null
  html_content?: string | null
}

type ReaderResponse = {
  count: number
  nextPageCursor: string | null
  results: Article[]
}

type PlaybackState = {
  generation: number
  articleIndex: number
  chunks: string[]
  chunkIndex: number
}

type ConnectionMode = 'disconnected' | 'connected'

const API_URL = 'https://readwise.io/api/v3/list/'
const AUTH_URL = 'https://readwise.io/api/v2/auth/'
const LEGACY_SESSION_TOKEN_KEY = 'readwise-listen-token'
const LOCATION_KEY = 'readwise-listen-location'
const VOICE_KEY = 'readwise-listen-voice'
const RATE_KEY = 'readwise-listen-rate'
const POSITION_KEY = 'readwise-listen-positions'
const DB_NAME = 'readwise-listen-cache'
const DB_VERSION = 1
const STORE_NAME = 'articles'

const locations: { value: LibraryLocation; label: string }[] = [
  { value: 'new', label: 'Inbox' },
  { value: 'later', label: 'Later' },
  { value: 'shortlist', label: 'Shortlist' },
  { value: 'archive', label: 'Archive' },
  { value: '', label: 'All articles' },
]

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('location', 'location', { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function cacheArticles(articles: Article[]) {
  if (!articles.length) return
  const db = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    articles.forEach((article) => store.put(article))
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  db.close()
}

async function readCachedArticles(location: LibraryLocation): Promise<Article[]> {
  const db = await openDatabase()
  const results = await new Promise<Article[]>((resolve, reject) => {
    const store = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME)
    const request = location ? store.index('location').getAll(IDBKeyRange.only(location)) : store.getAll()
    request.onsuccess = () => resolve(request.result as Article[])
    request.onerror = () => reject(request.error)
  })
  db.close()
  return results
    .filter((article) => article.category === 'article' && (!location || article.location === location))
    .sort((a, b) => (b.saved_at || '').localeCompare(a.saved_at || ''))
}

function htmlToReadableText(html: string | null | undefined, fallback: string) {
  if (!html) return fallback.trim()
  const document = new DOMParser().parseFromString(html, 'text/html')
  document
    .querySelectorAll('script, style, nav, form, button, svg, noscript, iframe, canvas, template')
    .forEach((node) => node.remove())

  const readableBlockSelector = 'h1, h2, h3, h4, p, li, blockquote, figcaption, pre'
  const blocks = Array.from(document.body.querySelectorAll(readableBlockSelector))
    .filter((node) => !node.querySelector(readableBlockSelector))
    .map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim())
    .filter((text) => text.length > 1)

  const text = blocks.length ? blocks.join('\n') : document.body.textContent || ''
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() || fallback.trim()
}

function splitLongText(text: string, maxChars: number) {
  const pieces: string[] = []
  let remaining = text.trim()
  while (remaining.length > maxChars) {
    let splitAt = Math.max(
      remaining.lastIndexOf(', ', maxChars),
      remaining.lastIndexOf('; ', maxChars),
      remaining.lastIndexOf(' ', maxChars),
    )
    if (splitAt < Math.floor(maxChars * 0.55)) splitAt = maxChars
    pieces.push(remaining.slice(0, splitAt + 1).trim())
    remaining = remaining.slice(splitAt + 1).trim()
  }
  if (remaining) pieces.push(remaining)
  return pieces
}

function textToSpeechChunks(text: string, maxChars = 220) {
  const sentences: string[] = []
  try {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' })
    for (const segment of segmenter.segment(text)) {
      const value = segment.segment.replace(/\s+/g, ' ').trim()
      if (value) sentences.push(...splitLongText(value, maxChars))
    }
  } catch {
    const matches = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text]
    matches.forEach((sentence) => sentences.push(...splitLongText(sentence, maxChars)))
  }

  const chunks: string[] = []
  let current = ''
  for (const sentence of sentences) {
    if (!current) current = sentence
    else if (`${current} ${sentence}`.length <= maxChars) current = `${current} ${sentence}`
    else {
      chunks.push(current)
      current = sentence
    }
  }
  if (current) chunks.push(current)
  return chunks
}

function buildArticleChunks(article: Article) {
  const fallback = [article.summary, article.title].filter(Boolean).join('. ')
  const body = htmlToReadableText(article.html_content, fallback)
  const intro = [article.title, article.author ? `By ${article.author}.` : ''].filter(Boolean).join('. ')
  const withoutRepeatedTitle = body.toLowerCase().startsWith(article.title.toLowerCase())
    ? body.slice(article.title.length).trim()
    : body
  return textToSpeechChunks(`${intro}\n${withoutRepeatedTitle}`)
}

function estimatedListeningTime(article: Article, rate = 1) {
  if (article.listening_time) return article.listening_time
  const minutes = Math.max(1, Math.round((article.word_count || 200) / 165 / rate))
  return `${minutes} min`
}

function getPositions(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(POSITION_KEY) || '{}')
  } catch {
    return {}
  }
}

function savePosition(articleId: string, chunk: number) {
  const positions = getPositions()
  positions[articleId] = chunk
  const entries = Object.entries(positions).slice(-500)
  localStorage.setItem(POSITION_KEY, JSON.stringify(Object.fromEntries(entries)))
}

function createSilentAudio() {
  const sampleRate = 8000
  const sampleCount = sampleRate
  const buffer = new ArrayBuffer(44 + sampleCount * 2)
  const view = new DataView(buffer)
  const write = (offset: number, value: string) =>
    [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)))
  write(0, 'RIFF')
  view.setUint32(4, 36 + sampleCount * 2, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, sampleCount * 2, true)
  const url = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }))
  const audio = new Audio(url)
  audio.loop = true
  audio.volume = 0.01
  return { audio, url }
}

function App() {
  const [tokenInput, setTokenInput] = useState('')
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('disconnected')
  const [location, setLocation] = useState<LibraryLocation>(() =>
    (localStorage.getItem(LOCATION_KEY) as LibraryLocation) || 'new',
  )
  const [articles, setArticles] = useState<Article[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [isOffline, setIsOffline] = useState(!navigator.onLine)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [currentChunk, setCurrentChunk] = useState(0)
  const [chunkCount, setChunkCount] = useState(1)
  const [rate, setRate] = useState(() => Number(localStorage.getItem(RATE_KEY)) || 1.25)
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [voiceURI, setVoiceURI] = useState(() => localStorage.getItem(VOICE_KEY) || '')
  const [query, setQuery] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [autoAdvance, setAutoAdvance] = useState(true)

  const articlesRef = useRef<Article[]>([])
  const tokenRef = useRef('')
  const cursorRef = useRef(nextCursor)
  const locationRef = useRef(location)
  const rateRef = useRef(rate)
  const voiceRef = useRef(voiceURI)
  const autoAdvanceRef = useRef(autoAdvance)
  const playbackRef = useRef<PlaybackState>({ generation: 0, articleIndex: 0, chunks: [], chunkIndex: 0 })
  const speakChunkRef = useRef<(generation: number) => void>(() => undefined)
  const startArticleRef = useRef<(index: number, chunk?: number) => void>(() => undefined)
  const advanceArticleRef = useRef<(direction: number) => Promise<void>>(async () => undefined)
  const fetchPageRef = useRef<
    (reset: boolean, tokenOverride?: string, locationOverride?: LibraryLocation) => Promise<Article[]>
  >(async () => [])
  const silentAudioRef = useRef<{ audio: HTMLAudioElement; url: string } | null>(null)
  const activeRequestRef = useRef<AbortController | null>(null)
  const requestGenerationRef = useRef(0)
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null)
  const settingsDialogRef = useRef<HTMLElement | null>(null)
  const settingsCloseRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => { articlesRef.current = articles }, [articles])
  useEffect(() => { cursorRef.current = nextCursor }, [nextCursor])
  useEffect(() => { locationRef.current = location }, [location])
  useEffect(() => {
    rateRef.current = rate
    localStorage.setItem(RATE_KEY, String(rate))
  }, [rate])
  useEffect(() => {
    voiceRef.current = voiceURI
    localStorage.setItem(VOICE_KEY, voiceURI)
  }, [voiceURI])
  useEffect(() => { autoAdvanceRef.current = autoAdvance }, [autoAdvance])

  const stopPlayback = useCallback(() => {
    playbackRef.current.generation += 1
    speechSynthesis.cancel()
    silentAudioRef.current?.audio.pause()
    setIsPlaying(false)
    setIsPaused(false)
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'none'
      navigator.mediaSession.metadata = null
    }
  }, [])

  const invalidateAsyncWork = useCallback(() => {
    requestGenerationRef.current += 1
    activeRequestRef.current?.abort()
    activeRequestRef.current = null
    return requestGenerationRef.current
  }, [])

  const fetchPage = useCallback(async (reset: boolean, tokenOverride?: string, locationOverride?: LibraryLocation) => {
    const activeToken = tokenOverride ?? tokenRef.current
    const activeLocation = locationOverride ?? locationRef.current
    if (!activeToken) return []
    const requestGeneration = invalidateAsyncWork()
    const controller = new AbortController()
    activeRequestRef.current = controller
    if (reset) setIsLoading(true)
    else setIsLoadingMore(true)
    setError('')
    try {
      const parameters = new URLSearchParams({ category: 'article', limit: '100', withHtmlContent: 'true' })
      if (activeLocation) parameters.set('location', activeLocation)
      if (!reset && cursorRef.current) parameters.set('pageCursor', cursorRef.current)
      const response = await fetch(`${API_URL}?${parameters.toString()}`, {
        headers: { Authorization: `Token ${activeToken}` },
        signal: controller.signal,
      })
      if (response.status === 401 || response.status === 403) throw new Error('That token was not accepted by Readwise.')
      if (response.status === 429) throw new Error('Readwise is rate-limiting requests. Wait a moment, then try again.')
      if (!response.ok) throw new Error(`Readwise returned ${response.status}. Please try again.`)
      const data = (await response.json()) as ReaderResponse
      if (
        controller.signal.aborted ||
        requestGeneration !== requestGenerationRef.current ||
        activeToken !== tokenRef.current ||
        activeLocation !== locationRef.current
      ) return []
      const incoming = data.results.filter((article) => article.html_content || article.summary)
      const existing = reset ? [] : articlesRef.current
      const known = new Set(existing.map((article) => article.id))
      const merged = [...existing, ...incoming.filter((article) => !known.has(article.id))]
      articlesRef.current = merged
      cursorRef.current = data.nextPageCursor
      setArticles(merged)
      setTotalCount(data.count)
      setNextCursor(data.nextPageCursor)
      setNotice(incoming.length ? `${incoming.length} articles ready to listen` : 'No readable articles found here')
      try {
        await cacheArticles(incoming)
      } catch {
        if (requestGeneration === requestGenerationRef.current) {
          setNotice(`${incoming.length} articles loaded · offline cache unavailable`)
        }
      }
      if (requestGeneration !== requestGenerationRef.current) return []
      return incoming
    } catch (caught) {
      if (controller.signal.aborted || requestGeneration !== requestGenerationRef.current) return []
      const message = caught instanceof Error ? caught.message : 'Could not reach Readwise.'
      setError(message)
      try {
        const cached = await readCachedArticles(activeLocation)
        if (requestGeneration !== requestGenerationRef.current) return []
        if (reset && cached.length) {
          articlesRef.current = cached
          setArticles(cached)
          setNotice(`Offline mode · ${cached.length} cached articles`)
        }
      } catch {
        // The network error above is more useful than a secondary cache error.
      }
      return []
    } finally {
      if (requestGeneration === requestGenerationRef.current) {
        activeRequestRef.current = null
        setIsLoading(false)
        setIsLoadingMore(false)
      }
    }
  }, [invalidateAsyncWork])
  useEffect(() => { fetchPageRef.current = fetchPage }, [fetchPage])

  const speakChunk = useCallback((generation: number) => {
    const playback = playbackRef.current
    if (playback.generation !== generation) return
    const text = playback.chunks[playback.chunkIndex]
    if (!text) return
    const utterance = new SpeechSynthesisUtterance(text)
    const selectedVoice = speechSynthesis.getVoices().find((voice) => voice.voiceURI === voiceRef.current)
    if (selectedVoice) utterance.voice = selectedVoice
    utterance.rate = rateRef.current
    utterance.pitch = 1
    utterance.volume = 1
    utterance.onstart = () => {
      if (playbackRef.current.generation !== generation) return
      setIsPlaying(true)
      setIsPaused(false)
    }
    utterance.onend = () => {
      const current = playbackRef.current
      if (current.generation !== generation) return
      const article = articlesRef.current[current.articleIndex]
      if (current.chunkIndex + 1 < current.chunks.length) {
        current.chunkIndex += 1
        setCurrentChunk(current.chunkIndex)
        if (article) savePosition(article.id, current.chunkIndex)
        speakChunkRef.current(generation)
        return
      }
      if (article) savePosition(article.id, 0)
      if (autoAdvanceRef.current) void advanceArticleRef.current(1)
      else stopPlayback()
    }
    utterance.onerror = (event) => {
      if (event.error === 'canceled' || event.error === 'interrupted') return
      setError(`The browser voice stopped (${event.error}). Press play to resume.`)
      setIsPlaying(false)
      silentAudioRef.current?.audio.pause()
    }
    speechSynthesis.speak(utterance)
  }, [stopPlayback])
  useEffect(() => { speakChunkRef.current = speakChunk }, [speakChunk])

  const startArticle = useCallback((index: number, requestedChunk?: number) => {
    const article = articlesRef.current[index]
    if (!article) return
    speechSynthesis.cancel()
    const chunks = buildArticleChunks(article)
    const saved = getPositions()[article.id] || 0
    const startChunk = Math.min(requestedChunk ?? saved, Math.max(0, chunks.length - 1))
    const generation = playbackRef.current.generation + 1
    playbackRef.current = { generation, articleIndex: index, chunks, chunkIndex: startChunk }
    setCurrentIndex(index)
    setCurrentChunk(startChunk)
    setChunkCount(Math.max(1, chunks.length))
    setError('')
    if (!silentAudioRef.current) silentAudioRef.current = createSilentAudio()
    void silentAudioRef.current.audio.play().catch(() => undefined)
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: article.title,
        artist: article.author || article.site_name || 'Readwise Reader',
        album: 'Readwise Listen',
        artwork: article.image_url ? [{ src: article.image_url }] : [],
      })
      navigator.mediaSession.playbackState = 'playing'
    }
    speakChunkRef.current(generation)
  }, [])
  useEffect(() => { startArticleRef.current = startArticle }, [startArticle])

  const advanceArticle = useCallback(async (direction: number) => {
    const nextIndex = playbackRef.current.articleIndex + direction
    if (nextIndex >= 0 && nextIndex < articlesRef.current.length) {
      startArticleRef.current(nextIndex, 0)
      return
    }
    if (direction > 0 && cursorRef.current && tokenRef.current) {
      const previousLength = articlesRef.current.length
      const incoming = await fetchPageRef.current(false)
      if (incoming.length) {
        startArticleRef.current(previousLength, 0)
        return
      }
    }
    stopPlayback()
    setNotice(direction > 0 ? 'You reached the end of this queue.' : 'This is the first article.')
  }, [stopPlayback])
  useEffect(() => { advanceArticleRef.current = advanceArticle }, [advanceArticle])

  const togglePlayback = useCallback(() => {
    if (!articlesRef.current.length) return
    if (!isPlaying) {
      startArticleRef.current(currentIndex)
      return
    }
    if (isPaused) {
      speechSynthesis.resume()
      void silentAudioRef.current?.audio.play().catch(() => undefined)
      setIsPaused(false)
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
    } else {
      speechSynthesis.pause()
      silentAudioRef.current?.audio.pause()
      setIsPaused(true)
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'
    }
  }, [currentIndex, isPaused, isPlaying])

  const seekChunk = useCallback((delta: number) => {
    if (!playbackRef.current.chunks.length) {
      startArticleRef.current(currentIndex, 0)
      return
    }
    const next = Math.max(0, Math.min(playbackRef.current.chunks.length - 1, playbackRef.current.chunkIndex + delta))
    startArticleRef.current(playbackRef.current.articleIndex, next)
  }, [currentIndex])

  const connect = useCallback(async () => {
    if (isLoading) return
    const cleanToken = tokenInput.trim()
    if (!cleanToken) {
      setError('Paste your Readwise access token first.')
      return
    }
    setTokenInput('')
    const requestGeneration = invalidateAsyncWork()
    const controller = new AbortController()
    activeRequestRef.current = controller
    setIsLoading(true)
    setError('')
    try {
      const auth = await fetch(AUTH_URL, {
        headers: { Authorization: `Token ${cleanToken}` },
        signal: controller.signal,
      })
      if (controller.signal.aborted || requestGeneration !== requestGenerationRef.current) return
      if (!auth.ok) throw new Error('That token was not accepted by Readwise.')
      tokenRef.current = cleanToken
      setConnectionMode('connected')
      await fetchPageRef.current(true, cleanToken)
    } catch (caught) {
      if (controller.signal.aborted || requestGeneration !== requestGenerationRef.current) return
      tokenRef.current = ''
      setConnectionMode('disconnected')
      setError(caught instanceof Error ? caught.message : 'Could not connect to Readwise.')
      setIsLoading(false)
    }
  }, [invalidateAsyncWork, isLoading, tokenInput])

  const disconnect = useCallback(() => {
    invalidateAsyncWork()
    stopPlayback()
    tokenRef.current = ''
    setTokenInput('')
    articlesRef.current = []
    cursorRef.current = null
    setArticles([])
    setTotalCount(0)
    setNextCursor(null)
    setCurrentIndex(0)
    setCurrentChunk(0)
    setChunkCount(1)
    setIsLoading(false)
    setIsLoadingMore(false)
    setError('')
    setConnectionMode('disconnected')
    setSettingsOpen(false)
    setNotice('Disconnected. The token was erased from memory.')
  }, [invalidateAsyncWork, stopPlayback])

  const switchLocation = useCallback(async (value: LibraryLocation) => {
    const switchGeneration = invalidateAsyncWork()
    stopPlayback()
    setLocation(value)
    locationRef.current = value
    localStorage.setItem(LOCATION_KEY, value)
    const cached = await readCachedArticles(value)
    if (switchGeneration !== requestGenerationRef.current) return
    articlesRef.current = cached
    setArticles(cached)
    setCurrentIndex(0)
    setCurrentChunk(0)
    setChunkCount(1)
    cursorRef.current = null
    setNextCursor(null)
    if (tokenRef.current && navigator.onLine) await fetchPageRef.current(true, undefined, value)
    else setNotice(cached.length ? `${cached.length} cached articles` : 'Connect to load this queue')
  }, [invalidateAsyncWork, stopPlayback])

  useEffect(() => {
    const refreshVoices = () => {
      const available = speechSynthesis.getVoices()
      setVoices(available)
      if (!voiceRef.current && available.length) {
        const preferred =
          available.find((voice) => /Samantha|Daniel|Karen|Moira/i.test(voice.name)) ||
          available.find((voice) => voice.lang.toLowerCase().startsWith('en')) ||
          available[0]
        setVoiceURI(preferred.voiceURI)
      }
    }
    refreshVoices()
    speechSynthesis.addEventListener('voiceschanged', refreshVoices)
    return () => speechSynthesis.removeEventListener('voiceschanged', refreshVoices)
  }, [])

  useEffect(() => {
    const updateOnline = () => setIsOffline(!navigator.onLine)
    window.addEventListener('online', updateOnline)
    window.addEventListener('offline', updateOnline)
    return () => {
      window.removeEventListener('online', updateOnline)
      window.removeEventListener('offline', updateOnline)
    }
  }, [])

  useEffect(() => {
    // Remove credentials left by versions that persisted the token in Web Storage.
    sessionStorage.removeItem(LEGACY_SESSION_TOKEN_KEY)
  }, [])

  useEffect(() => {
    if (!settingsOpen) return
    const settingsTrigger = settingsTriggerRef.current
    settingsCloseRef.current?.focus()
    const handleDialogKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setSettingsOpen(false)
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(
        settingsDialogRef.current?.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])') || [],
      ).filter((element) => !element.hasAttribute('disabled'))
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleDialogKeyboard)
    return () => {
      document.removeEventListener('keydown', handleDialogKeyboard)
      settingsTrigger?.focus()
    }
  }, [settingsOpen])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.setActionHandler('play', () => {
      if (speechSynthesis.paused) {
        speechSynthesis.resume()
        void silentAudioRef.current?.audio.play().catch(() => undefined)
        setIsPaused(false)
        navigator.mediaSession.playbackState = 'playing'
      } else if (!speechSynthesis.speaking) startArticleRef.current(playbackRef.current.articleIndex || 0)
    })
    navigator.mediaSession.setActionHandler('pause', () => {
      speechSynthesis.pause()
      silentAudioRef.current?.audio.pause()
      setIsPaused(true)
      navigator.mediaSession.playbackState = 'paused'
    })
    navigator.mediaSession.setActionHandler('previoustrack', () => void advanceArticleRef.current(-1))
    navigator.mediaSession.setActionHandler('nexttrack', () => void advanceArticleRef.current(1))
    navigator.mediaSession.setActionHandler('seekbackward', () => seekChunk(-1))
    navigator.mediaSession.setActionHandler('seekforward', () => seekChunk(1))
    return () => {
      ;['play', 'pause', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward'].forEach((action) => {
        try {
          navigator.mediaSession.setActionHandler(action as MediaSessionAction, null)
        } catch {
          // Some Brave versions expose only part of the Media Session API.
        }
      })
    }
  }, [seekChunk])

  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target.matches('input, select, textarea, button')) return
      if (event.code === 'Space') {
        event.preventDefault()
        togglePlayback()
      } else if (event.key === 'ArrowLeft' && event.shiftKey) void advanceArticleRef.current(-1)
      else if (event.key === 'ArrowRight' && event.shiftKey) void advanceArticleRef.current(1)
      else if (event.key === 'ArrowLeft') seekChunk(-1)
      else if (event.key === 'ArrowRight') seekChunk(1)
    }
    window.addEventListener('keydown', handleKeyboard)
    return () => window.removeEventListener('keydown', handleKeyboard)
  }, [seekChunk, togglePlayback])

  useEffect(() => () => {
    activeRequestRef.current?.abort()
    tokenRef.current = ''
    sessionStorage.removeItem(LEGACY_SESSION_TOKEN_KEY)
    speechSynthesis.cancel()
    if (silentAudioRef.current) URL.revokeObjectURL(silentAudioRef.current.url)
  }, [])

  const filteredArticles = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return articles.map((article, index) => ({ article, index }))
    return articles
      .map((article, index) => ({ article, index }))
      .filter(({ article }) =>
        [article.title, article.author, article.site_name, article.source]
          .filter(Boolean)
          .some((value) => value!.toLowerCase().includes(needle)),
      )
  }, [articles, query])

  const currentArticle = articles[currentIndex]
  const progress = chunkCount > 1 ? Math.round((currentChunk / (chunkCount - 1)) * 100) : 0
  const currentLocationLabel = locations.find((item) => item.value === location)?.label || 'Articles'

  if (connectionMode === 'disconnected') {
    return (
      <main className="connect-page">
        <div className="brand-mark" aria-label="Readwise Listen"><span>RW</span><i /><span>LISTEN</span></div>
        <section className="connect-card">
          <div className="connect-copy">
            <p className="eyebrow">Your reading queue, out loud</p>
            <h1>Turn your Readwise inbox into a continuous listen.</h1>
            <p className="lede">This player reads full articles one after another with Brave's built-in voices. No audio credits, no uploads, no manual switching.</p>
            <div className="privacy-note"><KeyRound size={18} /><span>Your token is hidden while typing, kept only in memory, and sent only to Readwise.</span></div>
          </div>
          <div className="connect-form">
            <label htmlFor="token">Readwise access token</label>
            <div className="token-row">
              <input id="token" type="password" autoComplete="new-password" autoCapitalize="none" spellCheck={false}
                data-1p-ignore="true" placeholder="Paste token here" value={tokenInput} disabled={isLoading}
                onChange={(event) => setTokenInput(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void connect()} />
              <button className="primary-button" onClick={() => void connect()} disabled={isLoading}>
                {isLoading ? <LoaderCircle className="spin" size={19} /> : <Headphones size={19} />}
                {isLoading ? 'Connecting' : 'Connect & load'}
              </button>
            </div>
            {error && <p className="form-error">{error}</p>}
            <a href="https://readwise.io/access_token" target="_blank" rel="noreferrer">Get your token from Readwise <ExternalLink size={14} /></a>
            <div className="connect-steps" aria-label="How it works"><span><b>1</b> Connect</span><span><b>2</b> Pick a queue</span><span><b>3</b> Press play</span></div>
          </div>
        </section>
        <p className="connect-footnote">Designed for Brave · Browser voices · Full article text</p>
      </main>
    )
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-mark small" aria-label="Readwise Listen"><span>RW</span><i /><span>LISTEN</span></div>
        <div className="topbar-right">
          {isOffline && <span className="offline-pill"><CloudOff size={14} /> Offline cache</span>}
          <span className="library-count">{articles.length.toLocaleString()} of {totalCount ? totalCount.toLocaleString() : '—'} loaded</span>
          <button ref={settingsTriggerRef} className="icon-button" aria-label="Settings" onClick={() => setSettingsOpen(true)}><Settings2 size={19} /></button>
        </div>
      </header>

      <main className="player-layout">
        <aside className="queue-panel">
          <div className="queue-heading">
            <div><p className="eyebrow">Up next</p><h2>{currentLocationLabel}</h2></div>
            <select aria-label="Choose Readwise queue" value={location} onChange={(event) => void switchLocation(event.target.value as LibraryLocation)}>
              {locations.map((item) => <option key={item.label} value={item.value}>{item.label}</option>)}
            </select>
          </div>
          <label className="search-field">
            <Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search loaded articles" />
            {query && <button aria-label="Clear search" onClick={() => setQuery('')}><X size={15} /></button>}
          </label>
          <div className="queue-list">
            {isLoading && !articles.length ? (
              <div className="queue-empty"><LoaderCircle className="spin" />Loading full articles…</div>
            ) : filteredArticles.length ? filteredArticles.map(({ article, index }) => (
              <button className={`queue-item ${index === currentIndex ? 'active' : ''}`} key={article.id} onClick={() => startArticle(index, 0)}>
                <span className="queue-index">{index === currentIndex && isPlaying ? <Volume2 size={15} /> : String(index + 1).padStart(2, '0')}</span>
                <span className="queue-copy"><strong>{article.title}</strong><small>{article.site_name || article.author || 'Readwise'} · {estimatedListeningTime(article, rate)}</small></span>
                {getPositions()[article.id] > 0 && <span className="resume-dot" title="In progress" />}
              </button>
            )) : <div className="queue-empty"><BookOpen />No articles match this search.</div>}
          </div>
          {nextCursor && <button className="load-more" onClick={() => void fetchPage(false)} disabled={isLoadingMore}>
            {isLoadingMore ? <LoaderCircle className="spin" size={17} /> : <RotateCcw size={17} />}{isLoadingMore ? 'Loading 100 more…' : 'Load 100 more'}
          </button>}
        </aside>

        <section className="now-playing">
          {currentArticle ? <>
            <div className="now-playing-topline">
              <span><span className="live-dot" /> {isPlaying ? (isPaused ? 'Paused' : 'Now speaking') : 'Ready to play'}</span>
              <a href={currentArticle.url} target="_blank" rel="noreferrer">Open in Reader <ExternalLink size={14} /></a>
            </div>
            <div className="artwork" aria-hidden="true">
              {currentArticle.image_url ? <img src={currentArticle.image_url} alt="" /> : <div className="artwork-fallback"><span>{String(currentIndex + 1).padStart(2, '0')}</span><BookOpen /></div>}
              <div className={`waveform ${isPlaying && !isPaused ? 'moving' : ''}`}>
                {[12, 25, 42, 20, 56, 33, 68, 38, 52, 23, 45, 17, 36, 27, 50, 20, 41, 29].map((height, index) => <i key={index} style={{ height: `${height}%`, animationDelay: `${index * -80}ms` }} />)}
              </div>
            </div>
            <div className="article-info">
              <p className="eyebrow">{currentArticle.site_name || currentArticle.source || 'From Readwise'}</p>
              <h1>{currentArticle.title}</h1>
              <p>{currentArticle.author ? `By ${currentArticle.author}` : 'Saved in Readwise'} · {estimatedListeningTime(currentArticle, rate)} listen</p>
            </div>
            <div className="progress-wrap">
              <div className="progress-labels"><span>{progress}%</span><span>Part {Math.min(currentChunk + 1, chunkCount)} of {chunkCount}</span></div>
              <div className="progress-track" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${progress}%` }} /></div>
            </div>
            <div className="transport" aria-label="Playback controls">
              <button onClick={() => void advanceArticle(-1)} aria-label="Previous article" title="Previous article"><SkipBack size={23} /></button>
              <button onClick={() => seekChunk(-1)} aria-label="Previous spoken section" title="Previous section"><ChevronLeft size={27} /></button>
              <button className="play-button" onClick={togglePlayback} aria-label={isPlaying && !isPaused ? 'Pause' : 'Play'}>
                {isPlaying && !isPaused ? <Pause size={31} fill="currentColor" /> : <Play size={31} fill="currentColor" />}
              </button>
              <button onClick={() => seekChunk(1)} aria-label="Next spoken section" title="Next section"><ChevronRight size={27} /></button>
              <button onClick={() => void advanceArticle(1)} aria-label="Next article" title="Next article"><SkipForward size={23} /></button>
            </div>
            <div className="playback-options">
              <label><Gauge size={17} /><span>Speed</span><select value={rate} onChange={(event) => {
                const nextRate = Number(event.target.value); rateRef.current = nextRate; setRate(nextRate); if (isPlaying) startArticleRef.current(currentIndex, currentChunk)
              }}>{[0.75, 1, 1.15, 1.25, 1.5, 1.75, 2, 2.25].map((value) => <option key={value} value={value}>{value}×</option>)}</select></label>
              <label><Volume2 size={17} /><span>Voice</span><select value={voiceURI} onChange={(event) => {
                voiceRef.current = event.target.value; setVoiceURI(event.target.value); if (isPlaying) startArticleRef.current(currentIndex, currentChunk)
              }}>{voices.map((voice) => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} · {voice.lang}</option>)}</select></label>
              <label className="auto-advance"><input type="checkbox" checked={autoAdvance} onChange={(event) => setAutoAdvance(event.target.checked)} /><span><Check size={13} /> Auto-play next</span></label>
            </div>
          </> : <div className="now-empty">
            {isLoading ? <LoaderCircle className="spin" size={36} /> : <Archive size={36} />}
            <h2>{isLoading ? 'Loading your queue' : 'Nothing queued yet'}</h2><p>{error || 'Choose another Readwise section or connect again.'}</p>
          </div>}
        </section>
      </main>

      <footer className="statusbar"><span>{error || notice || 'Ready'}</span><span className="keyboard-help"><kbd>Space</kbd> Play/pause <kbd>←</kbd><kbd>→</kbd> Skip section <kbd>Shift</kbd> + arrows Change article</span></footer>

      {settingsOpen && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setSettingsOpen(false)}>
        <section ref={settingsDialogRef} className="settings-card" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <button ref={settingsCloseRef} className="modal-close" aria-label="Close settings" onClick={() => setSettingsOpen(false)}><X /></button>
          <p className="eyebrow">Player settings</p><h2 id="settings-title">Your connection</h2>
          <div className="settings-status"><span><Check size={16} /></span><div><strong>Connected to Readwise</strong><small>Token hidden and held only in memory</small></div></div>
          <p className="settings-copy">Articles are cached for playback if your connection drops. The token is never displayed after submission, logged, written into app files, or saved in browser storage.</p>
          <div className="settings-actions"><a href="https://readwise.io/reader_api" target="_blank" rel="noreferrer">Readwise API details <ExternalLink size={14} /></a><button className="danger-button" onClick={disconnect}><LogOut size={17} /> Disconnect</button></div>
        </section>
      </div>}
    </div>
  )
}

export default App
