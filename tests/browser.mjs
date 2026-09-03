import { access } from 'node:fs/promises'

const macBravePath = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'

export async function browserLaunchOptions() {
  const requestedPath = process.env.BROWSER_EXECUTABLE
  if (requestedPath) return { headless: true, executablePath: requestedPath }

  try {
    await access(macBravePath)
    return { headless: true, executablePath: macBravePath }
  } catch {
    return { headless: true, channel: 'chromium' }
  }
}
