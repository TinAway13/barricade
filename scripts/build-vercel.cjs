const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const raw = (process.env.BLOCKLINE_WS_URL || '').trim();
let endpoint = 'unconfigured';
if (raw) {
  const url = new URL(raw);
  if (url.protocol !== 'wss:' || url.username || url.password || url.hash) {
    throw new Error('BLOCKLINE_WS_URL must be a public wss:// URL without credentials or a fragment.');
  }
  endpoint = url.href;
} else {
  console.warn('BLOCKLINE_WS_URL is missing. The page will load, but online play needs the Go backend URL.');
}
const escapeAttribute = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const html = fs.readFileSync(path.join(root, 'example.html'), 'utf8')
  .replace('<meta name="blockline-ws" content="">', `<meta name="blockline-ws" content="${escapeAttribute(endpoint)}">`);
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'index.html'), html);
console.log('Built dist/index.html');
