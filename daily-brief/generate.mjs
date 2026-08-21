import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Parser from 'rss-parser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const BRIEFS = join(REPO, 'briefs');
const parser = new Parser({ timeout: 30000 });

const KEY = process.env.DEEPSEEK_API_KEY || '';
if (!KEY) {
  console.error('DEEPSEEK_API_KEY belum diset.');
  process.exit(1);
}

function wibNow() { return new Date(Date.now() + 7 * 3600 * 1000); }
const now = wibNow();
const dateStr = now.toISOString().slice(0, 10);
const pretty = now.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' });

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function gather() {
  const feeds = JSON.parse(readFileSync(join(__dirname, 'feeds.json'), 'utf8'));
  const all = [];
  for (const url of feeds) {
    try {
      const feed = await parser.parseURL(url);
      const items = feed.items || [];
      for (const it of items.slice(0, 12)) {
        all.push({
          title: it.title || '',
          link: it.link || '',
          date: it.pubDate || it.isoDate || '',
          snippet: String(it.contentSnippet || it.content || '').replace(/\s+/g, ' ').slice(0, 280)
        });
      }
    } catch (e) {
      console.error('feed error: ' + url + ' -> ' + e.message);
    }
  }
  const seen = new Set();
  const uniq = [];
  for (const a of all) {
    const k = a.title.toLowerCase().slice(0, 60);
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(a);
  }
  uniq.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
  return uniq.slice(0, 60);
}

function material(items) {
  return items.map(function (it, i) {
    return (i + 1) + '. ' + it.title + '\n   ' + (it.date ? '[' + it.date + '] ' : '') + it.snippet + '\n   ' + it.link;
  }).join('\n\n');
}

async function callDeepSeek(promptText, news) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
    body: JSON.stringify({
      model: process.env.BRIEF_MODEL || 'deepseek-chat',
      messages: [
        { role: 'system', content: 'Anda analis executive intelligence kelas dewan untuk pemimpin Indonesia. Anda menulis Daily Executive Intelligence & Board Leadership Brief dalam Bahasa Indonesia.' },
        { role: 'user', content: promptText + '\n\n=== TANGGAL ===\n' + pretty + ' (' + dateStr + ')\n\n=== MATERI BERITA (dari agregator, perlu verifikasi bila dikutip) ===\n' + news + '\n\nTulis HTML lengkap sekarang. Kembalikan HANYA HTML (tanpa fence markdown, tanpa komentar).' }
      ],
      temperature: 0.4,
      stream: false
    }),
    signal: AbortSignal.timeout(300000)
  });
  if (!res.ok) {
    const b = await res.text();
    throw new Error('DeepSeek HTTP ' + res.status + ': ' + b.slice(0, 400));
  }
  const data = await res.json();
  let html = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  html = html.replace(/^\s*\x60\x60\x60[a-zA-Z]*\s*\n?/, '').replace(/\n?\x60\x60\x60\s*$/, '').trim();
  return html;
}

function extractHeadline(html) {
  const m = html.match(/<div class="headline"><p>([\s\S]*?)<\/p><\/div>/);
  if (m) return m[1].replace(/<[^>]+>/g, '').trim();
  const t = html.match(/<title>([\s\S]*?)<\/title>/);
  return t ? t[1].replace(/<[^>]+>/g, '').trim() : '';
}

function updateManifest(d, headline, file) {
  const p = join(BRIEFS, 'manifest.json');
  let m = {};
  if (existsSync(p)) { try { m = JSON.parse(readFileSync(p, 'utf8')); } catch (e) {} }
  m[d] = { date: d, headline: headline, file: file };
  writeFileSync(p, JSON.stringify(m, null, 2) + '\n', 'utf8');
}

function writeIndex() {
  const p = join(BRIEFS, 'manifest.json');
  let m = {};
  if (existsSync(p)) { try { m = JSON.parse(readFileSync(p, 'utf8')); } catch (e) {} }
  const dates = Object.keys(m).sort().reverse();
  const rows = dates.map(function (d) {
    const e = m[d];
    const dd = new Date(d + 'T00:00:00Z');
    const pd = dd.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' });
    return '<li><a href="' + e.file + '">' + pd + '</a> — ' + escapeHtml(e.headline || '') + '</li>';
  }).join('\n');
  const html = [
    '<!doctype html><html lang="id"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Daily Executive Brief — Arsip</title>',
    '<style>',
    ':root{--bg:#f7f6f3;--fg:#1b1a16;--fg2:#4a4840;--accent:#8a3324;--border:#e3e0d6}',
    '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#161512;--fg:#ece9e1;--fg2:#b6b3a8;--accent:#d58a72;--border:#2e2b24}}',
    'body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,sans-serif;line-height:1.6}',
    '.wrap{max-width:760px;margin:0 auto;padding:40px 20px 80px}',
    'h1{font-size:28px;margin:0 0 6px}',
    '.sub{color:var(--fg2);margin:0 0 24px}',
    'input{width:100%;padding:12px 14px;font-size:16px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);margin-bottom:20px;box-sizing:border-box}',
    'ul{list-style:none;padding:0}',
    'li{padding:14px 0;border-top:1px solid var(--border)}',
    'a{color:var(--accent);text-decoration:none;font-weight:600}',
    'li span{color:var(--fg2)}',
    '</style></head><body><div class="wrap">',
    '<h1>Daily Executive Brief</h1>',
    '<p class="sub">Arsip brief harian — ketik untuk memfilter.</p>',
    '<input type="search" placeholder="Cari tanggal atau topik…" oninput="f()">',
    '<ul id="list">',
    rows,
    '</ul>',
    '<script>function f(){var q=(document.querySelector("input").value||"").toLowerCase();var items=document.querySelectorAll("#list li");for(var i=0;i<items.length;i++){items[i].style.display=items[i].textContent.toLowerCase().indexOf(q)>-1?"":"none";}}</script>',
    '</div></body></html>'
  ].join('\n');
  writeFileSync(join(BRIEFS, 'index.html'), html, 'utf8');
}

async function main() {
  mkdirSync(BRIEFS, { recursive: true });
  const promptText = readFileSync(join(__dirname, 'prompt.md'), 'utf8');
  console.log('gathering news...');
  const items = await gather();
  console.log('gathered ' + items.length + ' items');
  const news = material(items);
  console.log('calling deepseek...');
  const html = await callDeepSeek(promptText, news);
  if (!html || html.length < 500) throw new Error('HTML output kosong/terlalu pendek');
  const file = dateStr + '.html';
  writeFileSync(join(BRIEFS, file), html + '\n', 'utf8');
  const headline = extractHeadline(html);
  updateManifest(dateStr, headline, file);
  writeIndex();
  console.log('done -> briefs/' + file);
}

main().catch(function (e) { console.error(e); process.exit(1); });
