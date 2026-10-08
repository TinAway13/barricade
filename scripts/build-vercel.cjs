const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const envMap = {
  apiKey: 'FIREBASE_API_KEY',
  authDomain: 'FIREBASE_AUTH_DOMAIN',
  databaseURL: 'FIREBASE_DATABASE_URL',
  projectId: 'FIREBASE_PROJECT_ID',
  appId: 'FIREBASE_APP_ID'
};
const missing = Object.values(envMap).filter(name => !(process.env[name] || '').trim());
if (missing.length) {
  throw new Error(`Missing Firebase environment variables: ${missing.join(', ')}`);
}
const firebaseConfig = Object.fromEntries(
  Object.entries(envMap).map(([key, name]) => [key, process.env[name].trim()])
);
if ((process.env.FIREBASE_STORAGE_BUCKET || '').trim()) firebaseConfig.storageBucket = process.env.FIREBASE_STORAGE_BUCKET.trim();
if ((process.env.FIREBASE_MESSAGING_SENDER_ID || '').trim()) firebaseConfig.messagingSenderId = process.env.FIREBASE_MESSAGING_SENDER_ID.trim();
if (!firebaseConfig.databaseURL.startsWith('https://')) {
  throw new Error('FIREBASE_DATABASE_URL must be an https:// Realtime Database URL.');
}
const escapeAttribute = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const html = fs.readFileSync(path.join(root, 'example.html'), 'utf8')
  .replace('<meta name="firebase-config" content="">', `<meta name="firebase-config" content="${escapeAttribute(JSON.stringify(firebaseConfig))}">`);
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'index.html'), html);
console.log('Built dist/index.html');
