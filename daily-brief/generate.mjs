import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Parser from 'rss-parser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const BRIEFS = join(REPO, 'briefs');
const parser = new Parser({ timeout: 30000 });
const SITE_URL = 'https://leaderbrief.id';
const FAVICON_LINK = '<link rel="icon" href="/favicon.svg" type="image/svg+xml">';
const GOOGLE_SITE_VERIFICATION = '<meta name="google-site-verification" content="D_rAihSMsnXvLIIEMHCEGqosuxUua9czU0NmXbOWrp8">';

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

function absUrl(pathname) {
  return SITE_URL + pathname;
}

function writeSeoFiles() {
  const m = loadManifest();
  const dates = Object.keys(m).sort().reverse();
  const latest = dates[0] || dateStr;
  const urls = [
    { loc: absUrl('/'), lastmod: latest },
    { loc: absUrl('/briefs/'), lastmod: latest },
    { loc: absUrl('/premium.html'), lastmod: latest },
    { loc: absUrl('/methodology.html'), lastmod: latest }
  ];
  for (const d of dates) {
    const e = m[d] || {};
    if (!e.file) continue;
    urls.push({ loc: absUrl('/briefs/' + e.file), lastmod: d });
  }

  const sitemap = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls.map(function (u) {
      return '  <url><loc>' + escapeHtml(u.loc) + '</loc><lastmod>' + escapeHtml(u.lastmod) + '</lastmod></url>';
    }).join('\n'),
    '</urlset>',
    ''
  ].join('\n');
  writeFileSync(join(REPO, 'sitemap.xml'), sitemap, 'utf8');

  const robots = [
    'User-agent: *',
    'Allow: /',
    '',
    'Sitemap: ' + absUrl('/sitemap.xml'),
    ''
  ].join('\n');
  writeFileSync(join(REPO, 'robots.txt'), robots, 'utf8');
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
    '<title>Daily Executive Brief | Arsip</title>',
    '<meta name="description" content="Arsip semua edisi Leader Brief, brief harian board-grade untuk pemimpin Indonesia.">',
    GOOGLE_SITE_VERIFICATION,
    '<link rel="canonical" href="' + absUrl('/briefs/') + '">',
    FAVICON_LINK,
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
    GOOGLE_SITE_VERIFICATION,
    '<link rel="canonical" href="' + absUrl('/') + '">',
    FAVICON_LINK,
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
    '.link{display:inline-block;margin-left:16px;color:var(--accent);text-decoration:none;font-size:15px;font-weight:600}',
    '.btn:hover{opacity:.9}',
    '.note{margin-top:18px;font-size:13px;color:var(--muted)}',
    '.audit{border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:12px 0;margin:26px 0 0;font-size:12.5px;color:var(--muted)}.audit b{color:var(--accent);text-transform:uppercase;letter-spacing:.08em}',
    '.foot{max-width:720px;margin:0 auto;padding:24px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}',
    '@media(max-width:640px){h1{font-size:31px}.sub{font-size:17px}main{padding:40px 20px 56px}.top{padding:20px}.btn{display:block;text-align:center}}',
    '</style>',
    '</head>',
    '<body>',
    '<div class="top"><div class="brand">Leader Brief</div></div>',
    '<main>',
    '  <h1>Brief harian yang mengubah berita menjadi keputusan.</h1>',
    '  <p class="sub">Ringkasan board-grade untuk pemimpin Indonesia. Setiap hari kerja kami kurasi perkembangan paling material dan terjemahkan menjadi tindakan yang siap dibawa ke rapat Direksi.</p>',
    '  <a class="btn" id="latest" href="' + latestHref + '">Baca Brief Terbaru</a><a class="link" href="./premium.html">Paket Premium</a><a class="link" href="./methodology.html">Metodologi</a>',
    '  <div class="note" id="note">' + latestNote + '</div>',
    '  <div class="audit"><b>Audit passed</b> · Dibantu AI, diverifikasi sumber, dan bertanggung jawab editorial. Pemeriksaan: kutipan, duplikasi, sumber primer, tangga keputusan, dan pola bahasa generik.</div>',
    '</main>',
    '<footer class="foot">Leader Brief · AI-assisted · Source-verified · Editorially accountable · leaderbrief.id</footer>',
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

function writePremiumPage() {
  const html = [
    '<!doctype html>',
    '<html lang="id">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Paket Premium | Leader Brief</title>',
    '<meta name="description" content="Paket premium dan korporasi Leader Brief untuk board intelligence, sponsor, dan briefing khusus pemimpin Indonesia.">',
    GOOGLE_SITE_VERIFICATION,
    '<link rel="canonical" href="' + absUrl('/premium.html') + '">',
    FAVICON_LINK,
    '<style>',
    ':root{--bg:#ffffff;--fg:#191919;--muted:#6b6b6b;--accent:#1a8917;--line:#e8e8e8;--serif:Newsreader,Georgia,serif;--sans:Inter,system-ui,sans-serif}',
    '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#121212;--fg:#e6e6e6;--muted:#9a9a9a;--accent:#3ddc3d;--line:#2a2a2a}}',
    '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans);line-height:1.7;-webkit-font-smoothing:antialiased}.wrap{max-width:880px;margin:0 auto;padding:32px 24px 80px}.brand{font-family:var(--serif);font-size:23px;font-weight:600;text-decoration:none;color:var(--fg)}',
    'header{border-bottom:1px solid var(--line);padding-bottom:18px;margin-bottom:44px;display:flex;justify-content:space-between;gap:18px;align-items:baseline;flex-wrap:wrap}nav a{color:var(--accent);text-decoration:none;font-size:14px;font-weight:600;margin-left:16px}h1{font-family:var(--serif);font-size:43px;line-height:1.12;font-weight:600;margin:0 0 18px}.dek{font-family:var(--serif);font-size:21px;line-height:1.5;color:var(--muted);max-width:700px;margin:0 0 34px}',
    '.plans{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px;margin:28px 0 42px}.plan{border-top:1px solid var(--line);padding-top:16px}.plan h2{font-size:18px;margin:0 0 6px}.price{font-size:13px;color:var(--accent);font-weight:700;margin:0 0 10px}.plan p{color:var(--muted);font-size:15px;margin:0}h3{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin:38px 0 12px}ul{padding-left:20px;color:var(--fg)}li{margin-bottom:8px}.audit{border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:14px 0;margin:0 0 30px;font-size:13px;color:var(--muted)}.audit b{color:var(--accent);text-transform:uppercase;letter-spacing:.08em}.cta{border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:24px 0;margin-top:34px}.btn{display:inline-block;background:var(--accent);color:#fff;padding:12px 22px;border-radius:24px;text-decoration:none;font-size:15px;font-weight:600}.foot{margin-top:44px;color:var(--muted);font-size:13px}',
    '@media(max-width:760px){h1{font-size:31px}.plans{grid-template-columns:1fr}nav a{margin-left:0;margin-right:14px}}',
    '</style>',
    '</head>',
    '<body><div class="wrap">',
    '<header><a class="brand" href="./">Leader Brief</a><nav><a href="./briefs/">Arsip</a><a href="./methodology.html">Metodologi</a><a href="./">Beranda</a></nav></header>',
    '<main>',
    '<h1>Board intelligence untuk keputusan yang tidak bisa menunggu.</h1>',
    '<p class="dek">Leader Brief publik membangun kebiasaan baca harian. Paket premium mengubahnya menjadi memo eksekutif, sesi briefing, dan sponsor placement untuk audiens pemimpin Indonesia.</p>',
    '<div class="audit"><b>Workflow</b> · AI-assisted, source-verified, editorially accountable. Brief disusun dengan bantuan otomasi, lalu diperiksa untuk kutipan, duplikasi, sumber primer, dan ketajaman keputusan.</div>',
    '<div class="plans">',
    '<section class="plan"><h2>Individu</h2><p class="price">Rp149.000-299.000 per bulan</p><p>Untuk eksekutif yang membutuhkan arsip lengkap, memo mingguan, dan watchlist keputusan 7-30 hari.</p></section>',
    '<section class="plan"><h2>Korporasi</h2><p class="price">Rp2.500.000-7.500.000 per bulan</p><p>Untuk Direksi, komisaris, corporate strategy, risk, legal, dan transformation office yang perlu briefing sektor dan board pack.</p></section>',
    '<section class="plan"><h2>Sponsor</h2><p class="price">Paket bulanan</p><p>Untuk brand B2B yang ingin menjangkau pembaca pengambil keputusan melalui sponsor yang diberi label jelas dan menjaga kepercayaan editorial.</p></section>',
    '</div>',
    '<h3>Produk awal</h3>',
    '<ul><li>Weekly board memo dari seluruh edisi pekan berjalan.</li><li>Custom briefing untuk rapat Direksi, Komite Risiko, atau tim strategi.</li><li>Sector watch: energi, BUMN, AI, capital allocation, dan governance.</li><li>Sponsor slot dengan disclosure yang jelas.</li></ul>',
    '<section class="cta"><h3>Pilot 30 hari</h3><p>Mulai dari satu memo mingguan, satu sesi briefing, dan satu daftar tema prioritas. Setelah respons pembaca terlihat, paket bisa dinaikkan ke langganan korporasi atau sponsorship.</p><p><a class="btn" href="https://wa.me/6281393000399?text=Saya%20ingin%20diskusi%20paket%20premium%20LeaderBrief." rel="noopener" target="_blank">Diskusikan paket</a></p></section>',
    '</main><footer class="foot">Leader Brief · AI-assisted · Source-verified · Editorially accountable</footer>',
    '</div></body></html>',
    ''
  ].join('\n');
  writeFileSync(join(REPO, 'premium.html'), html, 'utf8');
}

function writeMethodologyPage() {
  const html = [
    '<!doctype html>',
    '<html lang="id">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Metodologi | Leader Brief</title>',
    '<meta name="description" content="Cara Leader Brief menggunakan AI, sumber publik, audit kutipan, dan tanggung jawab editorial sebelum publikasi.">',
    GOOGLE_SITE_VERIFICATION,
    '<link rel="canonical" href="' + absUrl('/methodology.html') + '">',
    FAVICON_LINK,
    '<style>',
    ':root{--bg:#ffffff;--fg:#191919;--muted:#6b6b6b;--accent:#1a8917;--line:#e8e8e8;--serif:Newsreader,Georgia,serif;--sans:Inter,system-ui,sans-serif}',
    '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#121212;--fg:#e6e6e6;--muted:#9a9a9a;--accent:#3ddc3d;--line:#2a2a2a}}',
    '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans);line-height:1.7;-webkit-font-smoothing:antialiased}.wrap{max-width:760px;margin:0 auto;padding:32px 24px 80px}.brand{font-family:var(--serif);font-size:23px;font-weight:600;text-decoration:none;color:var(--fg)}',
    'header{border-bottom:1px solid var(--line);padding-bottom:18px;margin-bottom:44px;display:flex;justify-content:space-between;gap:18px;align-items:baseline;flex-wrap:wrap}nav a{color:var(--accent);text-decoration:none;font-size:14px;font-weight:600;margin-left:16px}h1{font-family:var(--serif);font-size:42px;line-height:1.12;font-weight:600;margin:0 0 18px}.dek{font-family:var(--serif);font-size:21px;line-height:1.5;color:var(--muted);margin:0 0 34px}h2{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin:34px 0 10px}.audit{border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:14px 0;margin:0 0 28px;font-size:13px;color:var(--muted)}.audit b{color:var(--accent);text-transform:uppercase;letter-spacing:.08em}p{margin:0 0 14px}li{margin-bottom:8px}.foot{border-top:1px solid var(--line);margin-top:42px;padding-top:18px;color:var(--muted);font-size:13px}',
    '@media(max-width:760px){h1{font-size:31px}nav a{margin-left:0;margin-right:14px}}',
    '</style>',
    '</head>',
    '<body><div class="wrap">',
    '<header><a class="brand" href="./">Leader Brief</a><nav><a href="./briefs/">Arsip</a><a href="./premium.html">Premium</a><a href="./">Beranda</a></nav></header>',
    '<main>',
    '<h1>Metodologi dan penggunaan AI.</h1>',
    '<p class="dek">Leader Brief memakai AI sebagai alat kerja editorial, bukan sebagai otoritas final. Nilai produk berada pada pemilihan sumber, struktur keputusan, dan audit sebelum publikasi.</p>',
    '<div class="audit"><b>Principle</b> · AI-assisted, source-verified, editorially accountable.</div>',
    '<h2>Bagaimana brief disusun</h2>',
    '<p>Runner mengumpulkan kandidat dari sumber publik, RSS, dan pencarian. Model bahasa membantu menyusun draf berdasarkan materi yang diberikan runner. Draf kemudian dipaksa mengikuti struktur board-grade: fakta, inferensi, implikasi keputusan, owner, horizon, outcome, dan escalation trigger.</p>',
    '<h2>Apa yang diaudit</h2>',
    '<ul><li>Kutipan dan tautan sumber harus tersedia.</li><li>Duplikasi isu dan pengulangan dari edisi sebelumnya ditekan.</li><li>Bahasa generik, em dash, filler, dan rekomendasi kosong ditolak.</li><li>Perbedaan antara fakta dan inferensi harus terlihat.</li><li>Keputusan investasi, hukum, dan teknis tetap menjadi tanggung jawab pembaca.</li></ul>',
    '<h2>Akuntabilitas</h2>',
    '<p>Kami tidak menyamarkan otomasi sebagai tulisan manusia murni. Kami juga tidak menyerahkan keputusan editorial kepada model. Leader Brief adalah produk editorial berbasis sumber publik yang dibantu AI dan diperiksa sebelum terbit.</p>',
    '</main><footer class="foot">Leader Brief · AI-assisted · Source-verified · Editorially accountable</footer>',
    '</div></body></html>',
    ''
  ].join('\n');
  writeFileSync(join(REPO, 'methodology.html'), html, 'utf8');
}

function injectTemplate(html, meta) {
  const css = readFileSync(join(__dirname, 'template.css'), 'utf8');
  const styleTag = '<style>\n' + css + '\n</style>';
  const pageTitle = (meta && (meta.lens || meta.dek)) ? escapeHtml((meta.lens || meta.dek).slice(0, 90)) + ' | Leader Brief' : pretty + ' | Leader Brief';
  const description = (meta && (meta.dek || meta.teaser || meta.lens)) ? escapeHtml((meta.dek || meta.teaser || meta.lens).slice(0, 160)) : 'Brief harian board-grade untuk pemimpin Indonesia.';
  const seo = [
    '<title>' + pageTitle + '</title>',
    '<meta name="description" content="' + description + '">',
    GOOGLE_SITE_VERIFICATION,
    '<link rel="canonical" href="' + absUrl('/briefs/' + dateStr + '.html') + '">',
    '<meta property="og:type" content="article">',
    '<meta property="og:title" content="' + pageTitle + '">',
    '<meta property="og:description" content="' + description + '">',
    '<meta property="og:url" content="' + absUrl('/briefs/' + dateStr + '.html') + '">'
  ].join('\n');
  html = html.replace(/<style[\s\S]*?<\/style>/gi, '');
  html = html.replace(/<title>[\s\S]*?<\/title>/gi, '');
  html = html.replace(/<meta\s+name=["']description["'][^>]*>/gi, '');
  html = html.replace(/<link\s+rel=["']canonical["'][^>]*>/gi, '');
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, seo + '\n' + FAVICON_LINK + '\n' + styleTag + '\n</head>');
  }
  return '<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' + seo + '\n' + FAVICON_LINK + styleTag + '</head><body>' + html + '</body></html>';
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
  const aside = '<aside class="aside"><div class="box"><div class="k">Edisi</div><p>' + pretty + '</p><p>Terbit setiap hari kerja pukul 05:30 WIB.</p></div><div class="box"><div class="k">Audit</div><p>AI-assisted, source-verified, editorially accountable.</p><p>Kutipan, duplikasi, sumber primer, tangga keputusan, dan pola bahasa generik diperiksa sebelum publikasi.</p></div><div class="box"><div class="k">Navigasi</div><p><a href="../briefs/">Lihat arsip edisi</a></p><p><a href="../premium.html">Paket premium</a></p><p><a href="../methodology.html">Metodologi</a></p><p><a href="../">Beranda Leader Brief</a></p></div></aside>';
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
  let html = await callDeepSeek(promptText, news);
  const meta = extractMeta(html);
  html = addChrome(injectTemplate(html, meta));
  if (!html || html.length < 500) throw new Error('HTML output kosong/terlalu pendek');
  const file = dateStr + '.html';
  writeFileSync(join(BRIEFS, file), html + '\n', 'utf8');
  updateManifest(dateStr, meta, file);
  writeIndex();
  writeHomePage();
  writePremiumPage();
  writeMethodologyPage();
  writeSeoFiles();
  console.log('done -> briefs/' + file);
}

main().catch(function (e) { console.error(e); process.exit(1); });
