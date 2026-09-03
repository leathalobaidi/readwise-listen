import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { browserLaunchOptions } from './browser.mjs'

const extensionPath = resolve(process.env.EXTENSION_PATH || process.argv[2] || 'dist')
const profilePath = await mkdtemp(join(tmpdir(), 'readwise-listen-extension-'))
const launchOptions = await browserLaunchOptions()
const context = await chromium.launchPersistentContext(profilePath, {
  ...launchOptions,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
})

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 })
  const extensionId = new URL(worker.url()).host

  await context.addInitScript(() => {
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
  })

  await context.route('https://readwise.io/api/v2/auth/', (route) =>
    route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } }),
  )
  await context.route('https://readwise.io/api/v3/list/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        count: 2,
        nextPageCursor: null,
        results: [
          {
            id: 'extension-one',
            url: 'https://read.readwise.io/new/read/extension-one',
            title: 'First extension article',
            author: 'Ada Example',
            site_name: 'Example Review',
            category: 'article',
            location: 'new',
            word_count: 330,
            saved_at: '2026-09-03T10:00:00Z',
            html_content: '<article><p>This is the full first extension article.</p></article>',
          },
          {
            id: 'extension-two',
            url: 'https://read.readwise.io/new/read/extension-two',
            title: 'Second extension article',
            author: 'Ben Example',
            site_name: 'Daily Example',
            category: 'article',
            location: 'new',
            word_count: 165,
            saved_at: '2026-09-03T09:00:00Z',
            html_content: '<article><p>This is the full second extension article.</p></article>',
          },
        ],
      }),
    }),
  )

  const playerPrefix = `chrome-extension://${extensionId}/index.html`
  await new Promise((resolve) => setTimeout(resolve, 250))
  let player = context.pages().find((page) => page.url().startsWith(playerPrefix))
  if (!player) {
    player = await context.newPage()
    await player.goto(`chrome-extension://${extensionId}/index.html`)
  } else {
    await player.reload()
  }

  const pageErrors = []
  player.on('pageerror', (error) => pageErrors.push(error.message))
  await player.getByLabel('Readwise access token').fill('test-extension-token')
  await player.getByRole('button', { name: 'Connect & load' }).click()
  await player.getByRole('heading', { name: 'First extension article' }).waitFor()
  assert.equal(await player.evaluate(() => sessionStorage.getItem('readwise-listen-token')), null)
  assert.equal(await player.evaluate(() => Array.from(
    { length: localStorage.length },
    (_, index) => localStorage.getItem(localStorage.key(index)),
  ).includes('test-extension-token')), false)
  assert.doesNotMatch(await player.locator('body').innerText(), /test-extension-token/)

  await player.getByRole('button', { name: 'Play' }).click()
  await player.getByText('Now speaking').waitFor()
  assert.match(await player.evaluate(() => window.__utterances[0].text), /full first extension article/i)
  await player.evaluate(() => window.__utterances.at(-1).onend())
  await player.getByRole('heading', { name: 'Second extension article' }).waitFor()

  await Promise.all([
    worker.evaluate(() => openOrFocusPlayer()),
    worker.evaluate(() => openOrFocusPlayer()),
    worker.evaluate(() => openOrFocusPlayer()),
  ])
  const playerTabs = context.pages().filter((page) => page.url().startsWith(playerPrefix))
  assert.equal(playerTabs.length, 1)

  await player.getByRole('button', { name: 'Settings' }).click()
  await player.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await player.getByLabel('Readwise access token').waitFor()
  assert.equal(await player.getByRole('heading', { name: 'Second extension article' }).count(), 0)
  assert.equal(await player.getByText('Connected to Readwise').count(), 0)
  assert.deepEqual(pageErrors, [])

  console.log(JSON.stringify({
    passed: true,
    manifestV3Loaded: true,
    fullTextSpoken: true,
    autoAdvanced: true,
    toolbarReusesOneTab: true,
    tokenNotPersisted: true,
    disconnectResetUi: true,
    pageErrors,
  }))
} finally {
  await context.close()
  await rm(profilePath, { recursive: true, force: true })
}
