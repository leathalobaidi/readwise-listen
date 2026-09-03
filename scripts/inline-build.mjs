import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(projectRoot, 'dist')
let html = await readFile(join(dist, 'index.html'), 'utf8')

const scriptMatch = html.match(/<script[^>]+src="([^"]+)"[^>]*><\/script>/)
const styleMatch = html.match(/<link[^>]+href="([^"]+\.css)"[^>]*>/)
if (!scriptMatch || !styleMatch) throw new Error('Could not find Vite assets to inline')

const assetPath = (value) => join(dist, value.replace(/^\//, ''))
const script = await readFile(assetPath(scriptMatch[1]), 'utf8')
const style = await readFile(assetPath(styleMatch[1]), 'utf8')

html = html
  .replace(styleMatch[0], () => `<style>${style}</style>`)
  .replace(scriptMatch[0], () => `<script type="module">${script}</script>`)

await writeFile(join(projectRoot, 'Readwise Listen.html'), html)
console.log('Created Readwise Listen.html')
