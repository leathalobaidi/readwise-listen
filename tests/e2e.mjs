import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { browserLaunchOptions } from './browser.mjs'

const playerUrl = process.env.PLAYER_URL || 'http://127.0.0.1:4173/'
const browser = await chromium.launch(await browserLaunchOptions())
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } })
const listRequests = []
const pageErrors = []

page.on('pageerror', (error) => pageErrors.push(error.message))

await page.addInitScript(() => {
  class MockUtterance {
    constructor(text) {
      this.text = text
      this.rate = 1
      this.pitch = 1
      this.volume = 1
      this.onstart = null
      this.onend = null
      this.onerror = null
    }
  }
  const voices = [{ voiceURI: 'mock-voice', name: 'Daniel', lang: 'en-GB', localService: true, default: true }]
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
  if (!window.MediaMetadata) window.MediaMetadata = class { constructor(init) { Object.assign(this, init) } }
})

await page.route('https://readwise.io/api/v2/auth/', (route) =>
  route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } }),
)

await page.route('https://readwise.io/api/v3/list/**', async (route) => {
  listRequests.push(route.request().url())
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({
      count: 2,
      nextPageCursor: null,
      results: [
        {
          id: 'one',
          url: 'https://read.readwise.io/new/read/one',
          title: 'First test article',
          author: 'Ada Example',
          site_name: 'Example Review',
          category: 'article',
          location: 'new',
          word_count: 330,
          saved_at: '2026-09-03T10:00:00Z',
          html_content: '<article><h1>First test article</h1><p>This is the complete first article.</p></article>',
        },
        {
          id: 'two',
          url: 'https://read.readwise.io/new/read/two',
          title: 'Second test article',
          author: 'Ben Example',
          site_name: 'Daily Example',
          category: 'article',
          location: 'new',
          word_count: 165,
          saved_at: '2026-09-03T09:00:00Z',
          html_content: '<article><p>This is the complete second article.</p></article>',
        },
      ],
    }),
  })
})

await page.goto(playerUrl, { waitUntil: 'networkidle' })
await page.getByLabel('Readwise access token').fill('test-token-never-real')
await page.getByRole('button', { name: 'Connect & load' }).click()
await page.getByRole('heading', { name: 'First test article' }).waitFor()

assert.equal(await page.locator('.queue-item').count(), 2)
assert.match(listRequests[0], /category=article/)
assert.match(listRequests[0], /withHtmlContent=true/)

await page.getByRole('button', { name: 'Play' }).click()
await page.waitForTimeout(250)
console.log(JSON.stringify({
  utterancesAfterPlay: await page.evaluate(() => window.__utterances.length),
  statusText: await page.locator('.now-playing-topline').innerText(),
  browserSpeaking: await page.evaluate(() => window.speechSynthesis.speaking),
}))
await page.getByText('Now speaking').waitFor({ timeout: 3_000 })
assert.equal(await page.evaluate(() => window.__utterances.length), 1)
assert.match(await page.evaluate(() => window.__utterances[0].text), /complete first article/i)

await page.evaluate(() => window.__utterances.at(-1).onend())
await page.getByRole('heading', { name: 'Second test article' }).waitFor()
assert.equal(await page.evaluate(() => sessionStorage.getItem('readwise-listen-token')), null)
assert.equal(await page.evaluate(() => Object.values(localStorage).includes('test-token-never-real')), false)
assert.doesNotMatch(await page.locator('body').innerText(), /test-token-never-real/)

await page.getByRole('button', { name: 'Settings' }).click()
await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
await page.getByLabel('Readwise access token').waitFor()
assert.equal(await page.getByRole('heading', { name: 'Second test article' }).count(), 0)
assert.equal(await page.getByText('Connected to Readwise').count(), 0)
assert.deepEqual(pageErrors, [])

await page.screenshot({ path: 'tests/readwise-player-tested.png', fullPage: true })
await browser.close()
console.log(JSON.stringify({
  passed: true,
  queueItems: 2,
  fullTextSpoken: true,
  autoAdvanced: true,
  tokenNotPersisted: true,
  disconnectResetUi: true,
  pageErrors,
}))
