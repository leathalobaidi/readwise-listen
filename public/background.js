const playerUrl = chrome.runtime.getURL('index.html')
const playerTabKey = 'readwiseListenPlayerTab'
let openingPlayer = null

async function findOrCreatePlayer() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['TAB'],
      documentUrls: [playerUrl],
    })
    const existingContext = contexts[0]
    if (typeof existingContext?.tabId === 'number') {
      const existing = await chrome.tabs.get(existingContext.tabId)
      await chrome.tabs.update(existingContext.tabId, { active: true })
      if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true })
      await chrome.storage.session.set({ [playerTabKey]: existingContext.tabId })
      return
    }
  }

  const stored = await chrome.storage.session.get(playerTabKey)
  const playerTabId = stored[playerTabKey]

  if (typeof playerTabId === 'number') {
    try {
      const existing = await chrome.tabs.get(playerTabId)
      await chrome.tabs.update(playerTabId, { active: true })
      if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true })
      return
    } catch {
      await chrome.storage.session.remove(playerTabKey)
    }
  }

  const created = await chrome.tabs.create({ url: playerUrl })
  if (created.id) await chrome.storage.session.set({ [playerTabKey]: created.id })
}

function openOrFocusPlayer() {
  if (openingPlayer) return openingPlayer
  openingPlayer = findOrCreatePlayer().finally(() => {
    openingPlayer = null
  })
  return openingPlayer
}

chrome.action.onClicked.addListener(() => {
  void openOrFocusPlayer()
})

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') void openOrFocusPlayer()
})

chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.get(playerTabKey).then((stored) => {
    if (stored[playerTabKey] === tabId) return chrome.storage.session.remove(playerTabKey)
  })
})
