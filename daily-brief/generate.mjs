import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Parser from 'rss-parser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const BRIEFS = join(REPO, 'briefs');
const parser = new Parser({ timeout: 30000 });

const DEEPSEEK = process.env.DEEPSEEK_API_KEY || '';
const TAVILY = process.env.TAVILY_API_KEY || '';
const SERPER = process.env.SERPER_API_KEY || '';

if (!DEEPSEEK) { console.error('DEEPSEEK_API_KEY belum diset.'); process.exit(1); }

function wibNow() { return new Date(Date.now() + 7 * 3600 * 1000); }
const now = wibNow();
const dateStr = now.toISOString().slice(0, 10);
const pretty = now.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' });

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function tavilySearch(q) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: TAVILY, query: q, max_results: 6, search_depth: 'advanced', include_answer: false }),
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error('tavily HTTP ' + res.status);
  const d = await res.json();
  return (d.results || []).map(function (r) { return { title: r.title, link: r.url, snippet: String(r.content || '').slice(0, 400) }; });
}

async function serperSearch(q) {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': SERPER },
    body: JSON.stringify({ q: q, num: 6 }),
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error('serper HTTP ' + res.status);
  const d = await res.json();
  return (d.organic || []).map(function (r) { return { title: r.title, link: r.link, snippet: String(r.snippet || '').slice(0, 400) }; });
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchPage(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (daily-brief/1.0)' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return '';
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('html')) return '';
    const html = await res.text();
    return stripHtml(html).slice(0, 2000);
  } catch (e) { return ''; }
}

function dedupe(all) {
  const seen = new Set();
  const out = [];
  for (const a of all) {
    const k = a.title.toLowerCase().slice(0, 60);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

async function gatherViaSearch() {
  const queries = JSON.parse(readFileSync(join(__dirname, 'queries.json'), 'utf8'));
  const all = [];
  for (const q of queries) {
    try {
      const rs = TAVILY ? await tavilySearch(q) : await serperSearch(q);
      for (const r of rs) all.push({ title: r.title, link: r.link, date: '', snippet: r.snippet });
    } catch (e) { console.error('search error: ' + q + ' -> ' + e.message); }
  }
  const uniq = dedupe(all);
  const top = uniq.slice(0, 8);
  for (const a of top) {
    const body = await fetchPage(a.link);
    if (body) a.snippet = a.snippet + ' [ARTIKEL] ' + body;
  }
  console.log('search: ' + all.length + ' raw, ' + uniq.length + ' uniq');
  return uniq.slice(0, 45);
}

async function gatherViaRss() {
  const feeds = JSON.parse(readFileSync(join(__dirname, 'feeds.json'), 'utf8'));
  const all = [];
  for (const url of feeds) {
    try {
      const feed = await parser.parseURL(url);
      const items = feed.items || [];
      for (const it of items.slice(0, 12)) {
        all.push({ title: it.title || '', link: it.link || '', date: it.pubDate || it.isoDate || '', snippet: String(it.contentSnippet || it.content || '').replace(/\s+/g, ' ').slice(0, 280) });
      }
    } catch (e) { console.error('feed error: ' + url + ' -> ' + e.message); }
  }
  const uniq = dedupe(all);
  uniq.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
  console.log('rss: ' + all.length + ' raw, ' + uniq.length + ' uniq');
  return uniq.slice(0, 60);
}

async function gather() {
  if (TAVILY || SERPER) return gatherViaSearch();
  console.log('tidak ada search API key — pakai RSS.');
  return gatherViaRss();
}

function material(items) {
  return items.map(function (it, i) {
    return (i + 1) + '. ' + it.title + '\n   ' + (it.date ? '[' + it.date + '] ' : '') + it.snippet + '\n   ' + it.link;
  }).join('\n\n');
}

async function callDeepSeek(promptText, news) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DEEPSEEK },
    body: JSON.stringify({
      model: process.env.BRIEF_MODEL || 'deepseek-chat',
      messages: [
        { role: 'system', content: 'Anda analis executive intelligence kelas dewan untuk pemimpin Indonesia. Anda menulis Daily Executive Intelligence & Board Leadership Brief dalam Bahasa Indonesia.' },
        { role: 'user', content: promptText + '\n\n=== TANGGAL ===\n' + pretty + ' (' + dateStr + ')\n\n=== MATERI RISET (dari search/RSS, perlu verifikasi bila dikutip) ===\n' + news + '\n\nTulis HTML lengkap sekarang. Kembalikan HANYA HTML (tanpa fence markdown, tanpa komentar).' }
      ],
      temperature: 0.4,
      stream: false
    }),
    signal: AbortSignal.timeout(300000)
  });
  if (!res.ok) { const b = await res.text(); throw new Error('DeepSeek HTTP ' + res.status + ': ' + b.slice(0, 400)); }
  const data = await res.json();
  let html = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  html = html.replace(/^\s*\x60\x60\x60[a-zA-Z]*\s*\n?/, '').replace(/\n?\x60\x60\x60\s*$/, '').trim();
  return html;
}

function stripTags(s) { return s.replace(/<[^>]+>/g, '').trim(); }

function extractMeta(html) {
  const dekM = html.match(/<p class="dek">([\s\S]*?)<\/p>/);
  const lensM = html.match(/<div class="lensa">([\s\S]*?)<\/div>/);
  const teaserM = html.match(/<meta name="teaser" content="([^"]*)">/);
  let lens = lensM ? stripTags(lensM[1]) : '';
  lens = lens.replace(/^Lensa hari ini\s*[:—-]?\s*/i, '').trim();
  return {
    dek: dekM ? stripTags(dekM[1]) : '',
    lens: lens,
    teaser: teaserM ? teaserM[1].trim() : ''
  };
}

function updateManifest(d, meta, file) {
  const p = join(BRIEFS, 'manifest.json');
  let m = {};
  if (existsSync(p)) { try { m = JSON.parse(readFileSync(p, 'utf8')); } catch (e) {} }
  const pd = new Date(d + 'T00:00:00Z').toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' });
  const title = pd + (meta.lens ? ' — ' + meta.lens : '');
  m[d] = { date: d, title: title, dek: meta.dek, teaser: meta.teaser, headline: meta.dek || meta.lens, file: file };
  writeFileSync(p, JSON.stringify(m, null, 2) + '\n', 'utf8');
}

function loadManifest() {
  const p = join(BRIEFS, 'manifest.json');
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    return {};
  }
}

function prettyDate(d) {
  return new Date(d + 'T00:00:00Z').toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' });
}

function writeIndex() {
  const m = loadManifest();
  const dates = Object.keys(m).sort().reverse();
  const rows = dates.map(function (d) {
    const e = m[d];
    const pd = prettyDate(d);
    const t = e.title || pd;
    const dek = e.dek || e.headline || '';
    return '<li><a href="' + e.file + '">' + t + '</a>' + (dek ? '<span>' + escapeHtml(dek) + '</span>' : '') + '</li>';
  }).join('\n');
  const html = [
    '<!doctype html><html lang="id"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Daily Executive Brief — Arsip</title>',
    '<style>',
    ':root{--bg:#ffffff;--fg:#191919;--fg2:#6b6b6b;--accent:#1a8917;--border:#e8e8e8}',
    '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#121212;--fg:#e6e6e6;--fg2:#9a9a9a;--accent:#3ddc3d;--border:#2a2a2a}}',
    'body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,sans-serif;line-height:1.6}',
    '.wrap{max-width:760px;margin:0 auto;padding:40px 20px 80px}',
    'h1{font-size:28px;margin:0 0 6px}',
    '.sub{color:var(--fg2);margin:0 0 24px}',
    'input{width:100%;padding:12px 14px;font-size:16px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);margin-bottom:20px;box-sizing:border-box}',
    'ul{list-style:none;padding:0}',
    'li{padding:14px 0;border-top:1px solid var(--border)}',
    'a{color:var(--accent);text-decoration:none;font-weight:600;display:block}',
    'li span{color:var(--fg2);display:block;margin-top:3px;font-size:13.5px;line-height:1.55}',
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

function writeHomePage() {
  const m = loadManifest();
  const dates = Object.keys(m).sort().reverse();
  const latest = dates[0] || '';
  const latestEntry = latest ? m[latest] : null;
  const latestHref = latestEntry ? './briefs/' + latestEntry.file : './briefs/';
  const latestNote = latest ? 'Brief terbaru: ' + prettyDate(latest) : 'Brief pertama sedang disiapkan.';
  const html = [
    '<!doctype html>',
    '<html lang="id">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Leader Brief</title>',
    '<meta name="description" content="Brief harian board-grade untuk pemimpin Indonesia: perkembangan kunci, sintesis dewan, dan watchlist 7–30 hari.">',
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    '<link href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">',
    '<style>',
    ':root{--bg:#ffffff;--fg:#191919;--muted:#6b6b6b;--accent:#1a8917;--line:#e8e8e8}',
    '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#121212;--fg:#e6e6e6;--muted:#9a9a9a;--accent:#3ddc3d;--line:#2a2a2a}}',
    '*{box-sizing:border-box}',
    'body{margin:0;background:var(--bg);color:var(--fg);font-family:"Inter",system-ui,sans-serif;line-height:1.7;-webkit-font-smoothing:antialiased}',
    '.top{max-width:720px;margin:0 auto;padding:28px 24px}',
    '.brand{font-family:"Newsreader",Georgia,serif;font-size:23px;font-weight:600;letter-spacing:-.01em}',
    'main{max-width:720px;margin:0 auto;padding:56px 24px 72px}',
    'h1{font-family:"Newsreader",Georgia,serif;font-size:46px;line-height:1.1;font-weight:600;letter-spacing:-.02em;margin:0 0 22px}',
    '.sub{font-size:19px;color:var(--muted);max-width:560px;margin:0 0 36px;line-height:1.6}',
    '.btn{display:inline-block;background:var(--accent);color:#fff;padding:12px 26px;border-radius:24px;text-decoration:none;font-size:15px;font-weight:500}',
    '.btn:hover{opacity:.9}',
    '.note{margin-top:18px;font-size:13px;color:var(--muted)}',
    '.foot{max-width:720px;margin:0 auto;padding:24px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}',
    '@media(max-width:640px){h1{font-size:31px}.sub{font-size:17px}main{padding:40px 20px 56px}.top{padding:20px}.btn{display:block;text-align:center}}',
    '</style>',
    '</head>',
    '<body>',
    '<div class="top"><div class="brand">Leader Brief</div></div>',
    '<main>',
    '  <h1>Brief harian yang mengubah berita menjadi keputusan.</h1>',
    '  <p class="sub">Ringkasan board-grade untuk pemimpin Indonesia. Setiap hari kerja kami kurasi perkembangan paling material dan terjemahkan menjadi tindakan yang siap dibawa ke rapat Direksi.</p>',
    '  <a class="btn" id="latest" href="' + latestHref + '">Baca Brief Terbaru</a>',
    '  <div class="note" id="note">' + latestNote + '</div>',
    '</main>',
    '<footer class="foot">Leader Brief · Setiap hari kerja pukul 05:30 WIB · leaderbrief.id</footer>',
    '<script>',
    '(function () {',
    "  var a = document.getElementById('latest');",
    "  var n = document.getElementById('note');",
    "  fetch('./briefs/manifest.json?v=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (m) {",
    '    var keys = Object.keys(m).sort().reverse();',
    '    if (keys.length > 0) {',
    '      var latest = keys[0];',
    "      var d = new Date(latest + 'T00:00:00Z');",
    "      var pretty = d.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' });",
    "      a.href = './briefs/' + m[latest].file;",
    "      n.textContent = 'Brief terbaru: ' + pretty;",
    '    }',
    '  }).catch(function () {});',
    '})();',
    '</script>',
    '</body>',
    '</html>'
  ].join('\n');
  writeFileSync(join(REPO, 'index.html'), html + '\n', 'utf8');
}

function injectTemplate(html) {
  const css = readFileSync(join(__dirname, 'template.css'), 'utf8');
  const styleTag = '<style>\n' + css + '\n</style>';
  html = html.replace(/<style[\s\S]*?<\/style>/gi, '');
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, styleTag + '\n</head>');
  }
  return '<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' + styleTag + '</head><body>' + html + '</body></html>';
}

function addChrome(html) {
  const secTitles = [];
  html = html.replace(/<h2 class="sec-kicker">([^<]*)<span class="spacer"><\/span><\/h2>/g, function (m, t) {
    secTitles.push(t);
    return '<h2 class="sec-kicker" id="sec-' + secTitles.length + '">' + t + '<span class="spacer"></span></h2>';
  });
  const itemTitles = [];
  html = html.replace(/<article class="item">([\s\S]*?)<h3>([\s\S]*?)<\/h3>/g, function (m, head, title) {
    const n = itemTitles.length + 1;
    itemTitles.push(title.replace(/<[^>]+>/g, '').trim());
    return '<article class="item" id="item-' + n + '">' + head + '<h3>' + title + '</h3>';
  });
  const links = [];
  secTitles.forEach(function (t, i) {
    const n = i + 1;
    links.push('<a href="#sec-' + n + '">' + t + '</a>');
    if (t === 'Perkembangan Kunci') {
      itemTitles.forEach(function (it, j) {
        const label = it.length > 50 ? it.slice(0, 50) + '…' : it;
        links.push('<a class="indent" href="#item-' + (j + 1) + '">' + (j + 1) + '. ' + label + '</a>');
      });
    }
  });
  const linksHtml = links.join('');
  const toc = '<aside class="toc"><div class="k">On this page</div>' + linksHtml + '</aside>';
  const tocMobile = '<details class="toc-mobile"><summary>Daftar isi</summary>' + linksHtml + '</details>';
  const aside = '<aside class="aside"><div class="box"><div class="k">Edisi</div><p>' + pretty + '</p><p>Terbit setiap hari kerja pukul 05:30 WIB.</p></div><div class="box"><div class="k">Navigasi</div><p><a href="../briefs/">Lihat arsip edisi</a></p><p><a href="../">Beranda Leader Brief</a></p></div></aside>';
  html = html.replace(/<body[^>]*>/, '<body>\n<div class="layout">\n' + toc + tocMobile);
  html = html.replace(/<\/body>/, aside + '\n</div>\n</body>');
  return html;
}

async function main() {
  mkdirSync(BRIEFS, { recursive: true });
  const promptText = readFileSync(join(__dirname, 'prompt.md'), 'utf8');
  console.log('gathering...');
  const items = await gather();
  const news = material(items);
  console.log('calling deepseek...');
  const html = addChrome(injectTemplate(await callDeepSeek(promptText, news)));
  if (!html || html.length < 500) throw new Error('HTML output kosong/terlalu pendek');
  const file = dateStr + '.html';
  writeFileSync(join(BRIEFS, file), html + '\n', 'utf8');
  const meta = extractMeta(html);
  updateManifest(dateStr, meta, file);
  writeIndex();
  writeHomePage();
  console.log('done -> briefs/' + file);
}

main().catch(function (e) { console.error(e); process.exit(1); });
