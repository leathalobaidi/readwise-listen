import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { browserLaunchOptions } from './browser.mjs'

const extensionPath = resolve(process.env.EXTENSION_PATH || process.argv[2] || 'dist')
const profilePath = await mkdtemp(join(tmpdir(), 'readwise-listen-security-'))
const tokenSentinel = 'rw_fake_secret_SENTINEL_7f31c9'
const requests = []
const consoleMessages = []
let scenario = 'normal'
let signalDisconnectRequest
const disconnectRequestStarted = new Promise((resolveStarted) => {
  signalDisconnectRequest = resolveStarted
})

const launchOptions = await browserLaunchOptions()
const context = await chromium.launchPersistentContext(profilePath, {
  ...launchOptions,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
})

try {
  await context.addInitScript(() => {
    class MockUtterance {
      constructor(text) {
        this.text = text
        this.rate = 1
        this.pitch = 1
        this.volume = 1
        this.voice = null
        this.onstart = null
        this.onend = null
        this.onerror = null
      }
    }
    const voices = [
      { voiceURI: 'voice-one', name: 'Daniel', lang: 'en-GB', localService: true, default: true },
      { voiceURI: 'voice-two', name: 'Samantha', lang: 'en-US', localService: true, default: false },
    ]
    window.__utterances = []
    window.SpeechSynthesisUtterance = MockUtterance
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        speaking: false,
        paused: false,
        getVoices: () => voices,
        addEventListener: () => {},
        removeEventListener: () => {},
        speak: (utterance) => {
          window.__utterances.push(utterance)
          window.speechSynthesis.speaking = true
          queueMicrotask(() => utterance.onstart?.())
        },
        cancel: () => { window.speechSynthesis.speaking = false },
        pause: () => { window.speechSynthesis.paused = true },
        resume: () => { window.speechSynthesis.paused = false },
      },
    })
  })

  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 })
  const extensionId = new URL(worker.url()).host

  const recordRequest = (request) => {
    requests.push({
      url: request.url(),
      authorization: request.headers().authorization || '',
      body: request.postData() || '',
    })
  }

  await context.route('https://readwise.io/api/v2/auth/', (route) => {
    recordRequest(route.request())
    return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } })
  })

  await context.route('https://readwise.io/api/v3/list/**', async (route) => {
    recordRequest(route.request())
    const url = new URL(route.request().url())
    const location = url.searchParams.get('location') || 'all'
    if (scenario === 'queue-race' && location === 'later') await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
    if (scenario === 'queue-race' && location === 'archive') await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
    if (scenario === 'disconnect-race' && location === 'shortlist') {
      signalDisconnectRequest()
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
    }
    const html = location === 'new'
      ? '<article><blockquote><p>Unique quoted sentence.</p></blockquote><p>Final sentence.</p></article>'
      : `<article><p>${location} article body.</p></article>`
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        count: 1,
        nextPageCursor: null,
        results: [{
          id: `${scenario}-${location}`,
          url: `https://read.readwise.io/new/read/${location}`,
          title: `${location.toUpperCase()} article`,
          category: 'article',
          location,
          html_content: html,
        }],
      }),
    }).catch(() => undefined)
  })

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  const playerPrefix = `chrome-extension://${extensionId}/index.html`
  let player = context.pages().find((page) => page.url().startsWith(playerPrefix))
  if (!player) {
    player = await context.newPage()
    await player.goto(playerPrefix)
  } else {
    await player.reload()
  }
  player.on('console', (message) => consoleMessages.push(message.text()))

  await player.getByLabel('Readwise access token').fill(tokenSentinel)
  await player.getByRole('button', { name: 'Connect & load' }).click()
  await player.getByRole('heading', { name: 'NEW article' }).waitFor()

  const storageSnapshot = await player.evaluate(() => ({
    session: Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.getItem(sessionStorage.key(index))),
    local: Array.from({ length: localStorage.length }, (_, index) => localStorage.getItem(localStorage.key(index))),
  }))
  assert.equal(JSON.stringify(storageSnapshot).includes(tokenSentinel), false)
  assert.doesNotMatch(await player.content(), new RegExp(tokenSentinel))

  await player.getByRole('button', { name: 'Play' }).click()
  await player.getByText('Now speaking').waitFor()
  const spokenText = await player.evaluate(() => window.__utterances[0].text)
  assert.equal(spokenText.match(/Unique quoted sentence/g)?.length, 1)

  const playbackSelects = player.locator('.playback-options select')
  await playbackSelects.nth(0).selectOption('2')
  assert.equal(await player.evaluate(() => window.__utterances.at(-1).rate), 2)
  await playbackSelects.nth(1).selectOption('voice-two')
  assert.equal(await player.evaluate(() => window.__utterances.at(-1).voice?.voiceURI), 'voice-two')

  scenario = 'queue-race'
  const queue = player.getByLabel('Choose Readwise queue')
  await queue.selectOption('later')
  await queue.selectOption('archive')
  await player.waitForTimeout(650)
  assert.equal(await queue.inputValue(), 'archive')
  await player.getByRole('heading', { name: 'ARCHIVE article' }).waitFor()
  assert.equal(await player.getByRole('heading', { name: 'LATER article' }).count(), 0)

  scenario = 'disconnect-race'
  await queue.selectOption('shortlist')
  await disconnectRequestStarted
  await player.getByRole('button', { name: 'Settings' }).click()
  await player.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await player.getByLabel('Readwise access token').waitFor()
  await player.waitForTimeout(650)
  assert.equal(await player.getByRole('heading', { name: 'SHORTLIST article' }).count(), 0)
  assert.equal(await player.getByText('Connected to Readwise').count(), 0)
  assert.equal(await player.evaluate(() => window.speechSynthesis.speaking), false)

  assert.ok(requests.length >= 4)
  for (const request of requests) {
    assert.match(request.url, /^https:\/\/readwise\.io\/api\/v[23]\/(?:auth|list)\//)
    assert.doesNotMatch(request.url, new RegExp(tokenSentinel))
    assert.doesNotMatch(request.body, new RegExp(tokenSentinel))
    assert.equal(request.authorization, `Token ${tokenSentinel}`)
  }
  assert.doesNotMatch(consoleMessages.join('\n'), new RegExp(tokenSentinel))

  console.log(JSON.stringify({
    passed: true,
    tokenOnlyInReadwiseAuthorizationHeader: true,
    tokenAbsentFromDomAndStorage: true,
    disconnectCancelsPendingRequest: true,
    queueRacePrevented: true,
    liveSpeedAndVoiceApplyImmediately: true,
    nestedArticleTextNotRepeated: true,
  }))
} finally {
  await context.close()
  await rm(profilePath, { recursive: true, force: true })
}
