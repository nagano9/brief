import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Parser from 'rss-parser';
import { AuditError, auditInstruction, auditLeaderBrief } from '../src/audit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const BRIEFS = join(REPO, 'briefs');
const ASSETS = join(REPO, 'assets');
const VISUALS = join(ASSETS, 'visuals');
const parser = new Parser({ timeout: 30000 });
const SITE_URL = 'https://leaderbrief.id';
const FAVICON_LINK = [
  '<link rel="icon" href="/favicon.ico" sizes="any">',
  '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
  '<link rel="icon" href="/favicon-48x48.png" type="image/png" sizes="48x48">',
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">',
  '<link rel="manifest" href="/site.webmanifest">',
  '<meta name="theme-color" content="#101510">'
].join('\n');
const GOOGLE_SITE_VERIFICATION = '<meta name="google-site-verification" content="D_rAihSMsnXvLIIEMHCEGqosuxUua9czU0NmXbOWrp8">';

const DEEPSEEK = process.env.DEEPSEEK_API_KEY || '';
const TAVILY = process.env.TAVILY_API_KEY || '';
const SERPER = process.env.SERPER_API_KEY || '';
const BRIEF_MODEL = process.env.BRIEF_MODEL || 'deepseek-v4-flash';
const BRIEF_MAX_TOKENS = Number(process.env.BRIEF_MAX_TOKENS || 12000);
const OPENAI = process.env.OPENAI_API_KEY || '';
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const OPENAI_IMAGE_SIZE = process.env.OPENAI_IMAGE_SIZE || '1536x1024';
const OPENAI_IMAGE_QUALITY = process.env.OPENAI_IMAGE_QUALITY || 'high';

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

function weekdayDeliverable() {
  const wd = now.toLocaleDateString('id-ID', { weekday: 'long', timeZone: 'Asia/Jakarta' }).toLowerCase();
  const map = {
    senin: {
      lens: 'Macro & Modal',
      product: 'Capital allocation memo',
      module: 'Cost of Capital Box',
      force: 'Tulis hurdle-rate implication, debt/refinancing exposure, kurs, hedging trigger, dan keputusan modal yang harus disiapkan.'
    },
    selasa: {
      lens: 'Energi & Offtake',
      product: 'Offtake and project bankability memo',
      module: 'Energy/Offtake Box',
      force: 'Tulis dampak ke PPA, captured price, curtailment, tender, grid readiness, financial close, dan risiko offtaker.'
    },
    rabu: {
      lens: 'Governance & BUMN',
      product: 'Governance and decision-rights memo',
      module: 'Governance Box',
      force: 'Tulis perubahan mandat, decision rights, konflik principal-agent, governance gate, dan implikasi untuk BUMN atau regulator.'
    },
    kamis: {
      lens: 'Operasi & AI',
      product: 'Execution and operating-model memo',
      module: 'Execution/AI Box',
      force: 'Tulis perubahan operating model, AI workflow, capability gap, vendor dependency, dan kontrol eksekusi 30-90 hari.'
    },
    jumat: {
      lens: 'Sintesis Minggu',
      product: 'Board integrated synthesis',
      module: 'Board Integrated Synthesis + What Not To Do + Watchlist 7-30 hari',
      force: 'Sintesis minggu harus menyatukan 3-5 tema, bukan mengulang berita harian. Tulis what not to do dan watchlist 7-30 hari.'
    }
  };
  return map[wd] || map.senin;
}

function leaderCoverageMap() {
  return [
    {
      name: 'Finance & Capital',
      owner: 'CEO, CFO, treasury, investment committee',
      basis: 'dipilih bila sinyal mengubah biaya modal, liquidity, kurs, refinancing, capex, dividen, hedging, atau capital allocation',
      decision: 'reprioritisasi modal, debt plan, cash buffer, hurdle rate, dan shareholder return'
    },
    {
      name: 'Operations & Execution',
      owner: 'CEO, COO, CTO/CIO, transformation office',
      basis: 'dipilih bila sinyal mengubah delivery proyek, productivity, procurement, supply chain, vendor dependency, AI workflow, SLA, atau bottleneck eksekusi',
      decision: 'perubahan operating model, resource allocation, vendor control, milestone, dan escalation path'
    },
    {
      name: 'Risk & Resilience',
      owner: 'CEO, CRO, legal, audit committee, risk committee',
      basis: 'dipilih bila sinyal mengubah regulatory risk, legal exposure, reputasi, cyber, continuity, covenant, downside scenario, atau climate transition risk',
      decision: 'risk appetite, mitigation owner, contingency, disclosure, dan trigger eskalasi'
    },
    {
      name: 'Strategy & Portfolio',
      owner: 'CEO, chief strategy, investment committee, board',
      basis: 'dipilih bila sinyal mengubah where to play, how to win, M&A, divestment, market entry, portfolio pruning, atau competitive position',
      decision: 'portfolio choice, strategic fit, optionality, timing masuk atau keluar, dan prioritas pertumbuhan'
    },
    {
      name: 'Governance & Decision Rights',
      owner: 'CEO, board, corporate secretary, shareholder office',
      basis: 'dipilih bila sinyal mengubah mandat pemegang saham, approval gate, delegation of authority, BUMN governance, atau decision rights',
      decision: 'siapa memutuskan apa, kapan naik ke board, dan kontrol akuntabilitas'
    },
    {
      name: 'People & Organization',
      owner: 'CEO, CHRO, business unit leaders',
      basis: 'dipilih bila sinyal mengubah capability gap, workforce plan, leadership bench, incentive, culture, operating rhythm, atau change adoption',
      decision: 'capability build, org design, leadership assignment, insentif, dan adoption plan'
    },
    {
      name: 'Market, Policy & Stakeholder',
      owner: 'CEO, public affairs, investor relations, commercial leaders',
      basis: 'dipilih bila sinyal mengubah policy direction, geopolitik, demand, customer pressure, investor sentiment, regulator stance, atau stakeholder coalition',
      decision: 'stakeholder engagement, pricing posture, policy response, communications, dan commercial timing'
    }
  ];
}

function leaderCoverageInstruction() {
  return leaderCoverageMap().map(function (c, i) {
    return [
      (i + 1) + '. ' + c.name,
      '   Owner: ' + c.owner,
      '   Basis pemilihan: ' + c.basis,
      '   Keputusan terdampak: ' + c.decision
    ].join('\n');
  }).join('\n\n');
}

function recentEditionMemory(limit = 10) {
  const manifest = loadManifest();
  const dates = Object.keys(manifest).sort().reverse().filter(function (d) { return d !== dateStr; }).slice(0, limit);
  if (!dates.length) return '(belum ada edisi sebelumnya)';
  return dates.map(function (d) {
    const entry = manifest[d] || {};
    const file = entry.file || (d + '.html');
    const path = join(BRIEFS, file);
    let headings = [];
    let lens = '';
    if (existsSync(path)) {
      const html = readFileSync(path, 'utf8');
      const lensM = html.match(/<div class="lensa">([\s\S]*?)<\/div>/i);
      lens = lensM ? stripTags(lensM[1]).slice(0, 120) : '';
      headings = [...html.matchAll(/<h3>([\s\S]*?)<\/h3>/gi)]
        .map(function (m) { return stripTags(m[1]).replace(/\s+/g, ' ').trim(); })
        .filter(Boolean)
        .slice(0, 4);
    }
    return [
      '- ' + d + ': ' + stripTags(entry.title || entry.headline || ''),
      entry.dek ? '  Dek: ' + stripTags(entry.dek).slice(0, 220) : '',
      lens ? '  Lensa: ' + lens : '',
      headings.length ? '  Topik: ' + headings.join(' | ') : ''
    ].filter(Boolean).join('\n');
  }).join('\n');
}

function editorialBriefing() {
  const d = weekdayDeliverable();
  return [
    '=== KONTRAK DELIVERABLE HARI INI ===',
    'Lensa wajib: ' + d.lens,
    'Produk editorial: ' + d.product,
    'Modul rotasi wajib: ' + d.module,
    d.force,
    '',
    '=== COVERAGE LEADER YANG BOLEH DIPILIH ===',
    leaderCoverageInstruction(),
    '',
    'BLOK WAJIB DI OUTPUT SETELAH DEK:',
    '<div class="coverage"><div class="blk-k">Basis coverage</div><ul><li><b>Coverage utama:</b> [pilih satu dari coverage leader]</li><li><b>Coverage sekunder:</b> [pilih satu, atau tulis "tidak dominan"]</li><li><b>Basis pemilihan:</b> [sinyal konkret dari materi riset: angka, kebijakan, peristiwa, atau keputusan]</li><li><b>Keputusan leader yang terdampak:</b> [jenis keputusan, owner, dan horizon]</li><li><b>Kenapa bukan coverage lain:</b> [alasan singkat mengapa coverage lain tidak menjadi lead hari ini]</li></ul></div>',
    '',
    '=== MEMORI 10 EDISI TERAKHIR, UNTUK MENGHINDARI MONOTON ===',
    recentEditionMemory(10),
    '',
    'ATURAN ANTI-MONOTON WAJIB:',
    '- Jangan membuka dengan isu, angle, atau sequence yang sama dengan edisi 10 hari terakhir kecuali ada delta baru yang eksplisit.',
    '- Bila isu lama masih muncul, tulis hanya sebagai Delta vs edisi sebelumnya, maksimal 6 baris, lalu alihkan ruang ke deliverable hari ini.',
    '- Minimal dua dari tiga Perkembangan Kunci harus berasal dari angle atau konsekuensi keputusan yang tidak menjadi lead dalam memori di atas.',
    '- Heat Map harus mengubah Signal atau Impact dari hari sebelumnya. Jangan memakai baris generik yang sama.',
    '- Aksi utama harus berupa owner, horizon, outcome, dan escalation trigger yang sesuai deliverable hari ini.'
  ].join('\n');
}

async function callDeepSeek(promptText, news) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DEEPSEEK },
    body: JSON.stringify({
      model: BRIEF_MODEL,
      max_tokens: BRIEF_MAX_TOKENS,
      messages: [
        { role: 'system', content: 'Anda analis executive intelligence kelas dewan untuk pemimpin Indonesia. Anda menulis Daily Executive Intelligence & Board Leadership Brief dalam Bahasa Indonesia.' },
        { role: 'user', content: promptText + '\n\n' + editorialBriefing() + '\n\n' + auditInstruction() + '\n\n=== TANGGAL ===\n' + pretty + ' (' + dateStr + ')\n\n=== MATERI RISET (dari search/RSS, perlu verifikasi bila dikutip) ===\n' + news + '\n\nTulis HTML lengkap sekarang. Kembalikan HANYA HTML (tanpa fence markdown, tanpa komentar).' }
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

function stripTags(s) { return String(s || '').replace(/<[^>]+>/g, '').trim(); }

function compactText(s, max) {
  return stripHtml(String(s || '')).replace(/\s+/g, ' ').trim().slice(0, max);
}

function extractBlock(html, className) {
  const source = String(html || '');
  const special = {
    coverage: /<div class="coverage">([\s\S]*?<\/ul>)\s*<\/div>/i,
    seconds: /<div class="seconds">([\s\S]*?<\/p>)\s*<\/div>/i,
    boardq: /<div class="boardq">([\s\S]*?<\/p>)\s*<\/div>/i,
    'table-wrap': /<div class="table-wrap">([\s\S]*?<\/table>)\s*<\/div>/i
  }[className];
  if (special) {
    const hit = source.match(special);
    if (hit) return compactText(hit[1], 900);
  }
  const re = new RegExp('<(?:div|section|article)[^>]*class=["\'][^"\']*' + className + '[^"\']*["\'][^>]*>([\\s\\S]*?)<\\/(?:div|section|article)>', 'i');
  const m = source.match(re);
  return m ? compactText(m[1], 900) : '';
}

function visualSource(html, meta) {
  const title = meta && (meta.lens || meta.dek) ? (meta.lens || meta.dek) : pretty;
  const coverage = extractBlock(html, 'coverage');
  const seconds = extractBlock(html, 'seconds');
  const boardq = extractBlock(html, 'boardq');
  const heatMap = extractBlock(html, 'table-wrap');
  return [
    'Tanggal: ' + pretty,
    'Lensa: ' + compactText(title, 180),
    'Dek: ' + compactText(meta && meta.dek, 240),
    'Basis coverage: ' + coverage,
    '60 detik: ' + seconds,
    'Board question: ' + boardq,
    'Heat map: ' + heatMap
  ].filter(function (line) { return line.replace(/^[^:]+:\s*/, '').trim(); }).join('\n');
}

function decisionMapPrompt(html, meta) {
  return [
    'Create a premium executive decision map for LeaderBrief.id, 16:10 landscape.',
    'Style: clean white background, master-level strategy whiteboard, precise black marker handwriting, subtle blue and green accents, controlled red only for escalation or risk.',
    'Content must feel like a board memo visual, not a startup infographic, not a dashboard, not a stock illustration.',
    'Use sparse Indonesian labels. Include these zones: keputusan inti, owner, horizon 7/30/90 hari, trade-off, risiko utama, trigger eskalasi, langkah minggu ini.',
    'Make the visual readable, restrained, professional, and consistent across daily editions. Avoid icons that look decorative. Avoid gradients, 3D, clip art, fake UI cards, and generic AI imagery.',
    'Base the map on this edition context:',
    visualSource(html, meta)
  ].join('\n\n');
}

function renderDecisionMapSvg(html, meta) {
  const lens = compactText(meta && (meta.lens || meta.dek), 72) || 'Executive Decision Map';
  const dek = compactText(meta && meta.dek, 130) || 'Peta keputusan eksekutif untuk edisi hari ini.';
  const coverage = extractBlock(html, 'coverage');
  const decision = compactText((coverage.match(/Keputusan leader yang terdampak:\s*([^\.]+[\.]?)/i) || [])[1] || dek, 110);
  const basis = compactText((coverage.match(/Basis pemilihan:\s*([^\.]+[\.]?)/i) || [])[1] || coverage, 120);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="1024" viewBox="0 0 1536 1024" role="img" aria-labelledby="t d">' +
    '<title id="t">Executive Decision Map LeaderBrief.id</title><desc id="d">Peta keputusan eksekutif untuk edisi LeaderBrief.</desc>' +
    '<rect width="1536" height="1024" fill="#fffdfa"/><path d="M120 164h1296M120 820h1296" stroke="#d8d1c5" stroke-width="3"/>' +
    '<text x="120" y="120" font-family="Georgia,serif" font-size="56" font-weight="700" fill="#151515">Executive Decision Map</text>' +
    '<text x="120" y="206" font-family="Arial,sans-serif" font-size="27" fill="#315f9c">' + escapeHtml(lens) + '</text>' +
    '<text x="120" y="258" font-family="Arial,sans-serif" font-size="30" fill="#232323">' + escapeHtml(dek) + '</text>' +
    '<g font-family="Arial,sans-serif"><text x="148" y="366" font-size="24" font-weight="700" fill="#315f9c">Keputusan inti</text>' +
    '<text x="148" y="418" font-size="28" fill="#171717">' + escapeHtml(decision) + '</text>' +
    '<text x="148" y="516" font-size="22" font-weight="700" fill="#167246">Langkah minggu ini</text>' +
    '<text x="148" y="562" font-size="25" fill="#171717">Tetapkan owner, horizon, dan trigger eskalasi sebelum isu masuk rapat berikutnya.</text>' +
    '<text x="148" y="660" font-size="22" font-weight="700" fill="#b53a35">Red flag</text>' +
    '<text x="148" y="706" font-size="25" fill="#171717">Keputusan ditunda tanpa asumsi, angka, atau batas waktu yang bisa diuji.</text>' +
    '<text x="900" y="366" font-size="24" font-weight="700" fill="#315f9c">Basis point</text>' +
    '<text x="900" y="418" font-size="25" fill="#171717">' + escapeHtml(basis) + '</text>' +
    '<text x="900" y="516" font-size="22" font-weight="700" fill="#167246">Horizon</text>' +
    '<text x="900" y="562" font-size="28" fill="#171717">7 hari: arahkan perhatian. 30 hari: uji asumsi. 90 hari: koreksi alokasi.</text>' +
    '<text x="900" y="706" font-size="23" fill="#777">LeaderBrief.id</text></g></svg>';
  return svg;
}

async function writeExecutiveDecisionMap(html, meta) {
  mkdirSync(VISUALS, { recursive: true });
  const basename = dateStr;
  if (OPENAI) {
    try {
      const res = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OPENAI },
        body: JSON.stringify({
          model: OPENAI_IMAGE_MODEL,
          prompt: decisionMapPrompt(html, meta),
          size: OPENAI_IMAGE_SIZE,
          quality: OPENAI_IMAGE_QUALITY,
          n: 1
        }),
        signal: AbortSignal.timeout(300000)
      });
      if (!res.ok) throw new Error('OpenAI image HTTP ' + res.status + ': ' + (await res.text()).slice(0, 240));
      const data = await res.json();
      const b64 = data && data.data && data.data[0] && data.data[0].b64_json;
      if (!b64) throw new Error('OpenAI image response tidak berisi b64_json');
      writeFileSync(join(VISUALS, basename + '.png'), Buffer.from(b64, 'base64'));
      return '/assets/visuals/' + basename + '.png';
    } catch (e) {
      console.error('visual OpenAI failed; publishing without visual: ' + e.message);
    }
  }
  return '';
}

function injectExecutiveDecisionMap(html, visualPath) {
  if (!visualPath || /class=["']decision-map["']/i.test(html)) return html;
  const figure = '<figure class="decision-map"><img src="' + visualPath + '" alt="Executive Decision Map LeaderBrief ' + pretty + '" loading="eager" decoding="async"><figcaption>Executive Decision Map. Ringkasan visual untuk keputusan, owner, horizon, trade-off, risiko, dan trigger eskalasi edisi ini.</figcaption></figure>';
  if (/<p class="dek">[\s\S]*?<\/p>/i.test(html)) {
    return html.replace(/(<p class="dek">[\s\S]*?<\/p>)/i, '$1\n' + figure);
  }
  return html.replace(/(<body[^>]*>\s*(?:<div class="wrap">)?)/i, '$1\n' + figure);
}

function injectVisualSeo(html, visualPath) {
  if (!visualPath) return html;
  const imageUrl = absUrl(visualPath);
  const tags = [
    '<meta property="og:image" content="' + imageUrl + '">',
    '<meta property="og:image:alt" content="Executive Decision Map LeaderBrief.id">',
    '<meta name="twitter:card" content="summary_large_image">',
    '<meta name="twitter:image" content="' + imageUrl + '">'
  ].join('\n');
  html = html
    .replace(/<meta\s+property=["']og:image["'][^>]*>\s*/gi, '')
    .replace(/<meta\s+property=["']og:image:alt["'][^>]*>\s*/gi, '')
    .replace(/<meta\s+name=["']twitter:card["'][^>]*>\s*/gi, '')
    .replace(/<meta\s+name=["']twitter:image["'][^>]*>\s*/gi, '');
  return html.replace(/<\/head>/i, tags + '\n</head>');
}

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

function normalizeAuditLanguage(html) {
  return String(html || '')
    .replace(/\bdi tengah dinamika\b/gi, 'dalam kondisi ini')
    .replace(/\bdalam lanskap\b/gi, 'dalam kondisi')
    .replace(/\bdi era\b/gi, 'pada fase')
    .replace(/\bseiring dengan perkembangan\b/gi, 'setelah perubahan')
    .replace(/\bimplikasinya jelas\b/gi, 'implikasinya')
    .replace(/\bke depan\b/gi, 'dalam 7-30 hari');
}

function updateManifest(d, meta, file) {
  const p = join(BRIEFS, 'manifest.json');
  let m = {};
  if (existsSync(p)) { try { m = JSON.parse(readFileSync(p, 'utf8')); } catch (e) {} }
  const pd = new Date(d + 'T00:00:00Z').toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' });
  const title = pd + (meta.lens ? ' - ' + meta.lens : '');
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

function editionSwitchHtml(currentDate) {
  const m = loadManifest();
  const dates = Object.keys(m).sort();
  const idx = dates.indexOf(currentDate);
  if (idx < 0) return '';
  const older = idx > 0 ? m[dates[idx - 1]] : null;
  const newer = idx < dates.length - 1 ? m[dates[idx + 1]] : null;
  if (!older && !newer) return '';
  return '<nav class="edition-switch" aria-label="Pindah edisi"><b>Pindah edisi</b>' +
    (older && older.file ? '<a href="./' + older.file + '">Sebelumnya</a><span>/</span>' : '') +
    '<a href="../briefs/">Arsip</a>' +
    (newer && newer.file ? '<span>/</span><a href="./' + newer.file + '">Berikutnya</a>' : '') +
    '</nav>';
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
    '<title>LeaderBrief.id | Arsip</title>',
    '<meta name="description" content="Arsip semua edisi LeaderBrief.id, brief harian board-grade untuk pemimpin Indonesia.">',
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
    '<h1>LeaderBrief.id Archive</h1>',
    '<p class="sub">Arsip brief harian. Ketik untuk memfilter tanggal atau topik.</p>',
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
  const previous = dates[1] || '';
  const latestEntry = latest ? m[latest] : null;
  const previousEntry = previous ? m[previous] : null;
  const latestHref = latestEntry ? './briefs/' + latestEntry.file : './briefs/';
  const previousHref = previousEntry ? './briefs/' + previousEntry.file : './briefs/';
  const latestNote = latest ? 'Brief terbaru: ' + prettyDate(latest) : 'Brief pertama sedang disiapkan.';
  const latestTitle = latestEntry && (latestEntry.title || latestEntry.headline)
    ? stripHtml(latestEntry.title || latestEntry.headline).replace(/^\S+,\s+\d+\s+\S+\s+\d+\s+[—-]\s+/, '')
    : 'Edisi terbaru sedang disiapkan';
  const latestDek = latestEntry && latestEntry.dek
    ? stripHtml(latestEntry.dek)
    : 'Lihat perkembangan paling material dan keputusan yang perlu disiapkan minggu ini.';
  const recentLinks = dates.slice(1, 5).map(function (d) {
    const e = m[d] || {};
    if (!e.file) return '';
    const title = stripHtml(e.title || e.headline || prettyDate(d)).replace(/^\S+,\s+\d+\s+\S+\s+\d+\s+[—-]\s+/, '');
    return '<li><a href="./briefs/' + e.file + '">' + escapeHtml(prettyDate(d)) + '</a><span>' + escapeHtml(title) + '</span></li>';
  }).join('');
  const html = [
    '<!doctype html>',
    '<html lang="id">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>LeaderBrief.id</title>',
    '<meta name="description" content="Brief harian board-grade untuk pemimpin Indonesia: perkembangan kunci, sintesis dewan, dan watchlist 7-30 hari.">',
    GOOGLE_SITE_VERIFICATION,
    '<link rel="canonical" href="' + absUrl('/') + '">',
    FAVICON_LINK,
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    '<link href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">',
    '<style>',
    ':root{--bg:#ffffff;--fg:#191919;--muted:#626866;--faint:#7f8783;--accent:#0f5c4d;--line:#e0e5e2;--line2:#b9c3bf;--card:#f8faf8;--serif:"Newsreader",Georgia,serif;--sans:"Inter",system-ui,sans-serif;--mono:ui-monospace,"SF Mono","Cascadia Mono",Consolas,monospace}',
    '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#101312;--fg:#e6e9e7;--muted:#98a19e;--faint:#7f8985;--accent:#5cbfa8;--line:#252a28;--line2:#39413e;--card:#171b1a}}',
    '*{box-sizing:border-box}',
    'body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans);line-height:1.7;-webkit-font-smoothing:antialiased}',
    '.wrap{max-width:960px;margin:0 auto;padding:0 24px}',
    'header{border-bottom:1px solid var(--line2);padding:24px 0 14px;margin-bottom:54px}',
    '.mast{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;padding-bottom:18px;border-bottom:1px solid var(--line)}',
    '.brand{font-family:var(--serif);font-size:30px;line-height:1.05;font-weight:600;letter-spacing:-.01em}.brand span{color:var(--accent)}',
    '.brand-sub{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-top:7px}',
    '.status{text-align:right;font-family:var(--mono);font-size:12px;color:var(--muted);letter-spacing:.05em}.status b{display:block;color:var(--fg);font-size:14px}.status span{text-transform:uppercase;color:var(--faint);font-size:11px;letter-spacing:.13em}',
    'nav{display:flex;justify-content:space-between;gap:18px;padding-top:13px;font-family:var(--mono);font-size:12px;text-transform:uppercase;letter-spacing:.1em}nav a{color:var(--muted);text-decoration:none}nav a:hover{color:var(--accent)}.nav-main{display:flex;gap:18px;flex-wrap:wrap}.premium{color:var(--fg);border:1px solid var(--line2);padding:4px 9px;margin-top:-5px}',
    'main{padding-bottom:76px}',
    '.hero{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(260px,.75fr);gap:44px;align-items:start}',
    'h1{font-family:var(--serif);font-size:50px;line-height:1.05;font-weight:600;letter-spacing:-.02em;margin:0 0 22px;max-width:720px}',
    '.sub{font-family:var(--serif);font-size:21px;color:var(--muted);max-width:650px;margin:0 0 30px;line-height:1.48}',
    '.actions{display:flex;gap:14px;flex-wrap:wrap;align-items:center}.btn{display:inline-block;background:var(--accent);color:#fff;padding:11px 18px;text-decoration:none;font-size:14px;font-weight:600}.link{color:var(--accent);text-decoration:none;font-size:14px;font-weight:600;border-bottom:1px solid var(--line2)}',
    '.latest{border-top:1px solid var(--line2);border-bottom:1px solid var(--line2);padding:18px 0}.k{font-family:var(--mono);font-size:11px;letter-spacing:.13em;text-transform:uppercase;color:var(--faint);margin-bottom:8px}.latest h2{font-family:var(--serif);font-size:24px;line-height:1.18;margin:0 0 8px}.latest h2 a{color:inherit;text-decoration:none}.latest p{font-size:14px;color:var(--muted);margin:0 0 10px;line-height:1.55}.note{font-family:var(--mono);font-size:12px;color:var(--muted)}.recent{border-top:1px solid var(--line);margin:16px 0 0;padding:12px 0 0}.recent ul{list-style:none;margin:0;padding:0}.recent li{border-top:1px solid var(--line);padding:10px 0}.recent li:first-child{border-top:0}.recent a{display:block;color:var(--accent);text-decoration:none;font-size:13px;font-weight:600}.recent span{display:block;color:var(--muted);font-size:13px;line-height:1.4;margin-top:2px}',
    '.audit{border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:12px 0;margin:30px 0 0;font-size:12.5px;color:var(--muted)}.audit b{color:var(--accent);text-transform:uppercase;letter-spacing:.08em}',
    '.context{border-top:1px solid var(--line2);border-bottom:1px solid var(--line2);padding:20px 0;margin:48px 0 42px}.context-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:18px}.context b{display:block;font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--faint);margin-bottom:4px}.context span{display:block;font-size:15px;color:var(--fg);line-height:1.35}.context small{display:block;font-family:var(--mono);font-size:11px;color:var(--muted);margin-top:5px}',
    '.proof{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:24px;border-top:1px solid var(--line);padding-top:24px}.proof h3{font-size:13px;margin:0 0 8px}.proof p{font-size:14px;color:var(--muted);margin:0;line-height:1.55}',
    '.foot{max-width:960px;margin:0 auto;padding:24px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}',
    '@media(max-width:820px){.hero{grid-template-columns:1fr}.context-grid,.proof{grid-template-columns:1fr 1fr}h1{font-size:38px}}',
    '@media(max-width:560px){.wrap{padding:0 18px}.mast{display:block}.status{text-align:left;margin-top:14px}nav{display:block}.nav-main{margin-bottom:12px}h1{font-size:32px}.sub{font-size:18px}.context-grid,.proof{grid-template-columns:1fr}.premium{display:inline-block}}',
    '</style>',
    '</head>',
    '<body>',
    '<header><div class="wrap"><div class="mast"><div><div class="brand">LeaderBrief<span>.id</span></div><div class="brand-sub">Policy · Capital · Execution</div></div><div class="status"><span>Latest brief</span><b id="status-date">' + (latest ? prettyDate(latest) : 'Menunggu edisi') + '</b><small>Board-ready daily intelligence</small></div></div><nav><div class="nav-main"><a href="./briefs/">Arsip</a><a href="./methodology.html">Metodologi</a><a href="./">Beranda</a></div><a class="premium" href="./premium.html">Premium</a></nav></div></header>',
    '<main class="wrap">',
    '<section class="hero">',
    '<div>',
    '  <h1>Brief harian yang mengubah berita menjadi keputusan.</h1>',
    '  <p class="sub">Ringkasan board-grade untuk pemimpin Indonesia: apa yang berubah, mengapa penting, dan keputusan apa yang perlu disiapkan dalam 7-30 hari.</p>',
    '  <div class="actions"><a class="btn" id="latest" href="' + latestHref + '">Baca Brief Terbaru</a><a class="link" id="previous" href="' + previousHref + '">Edisi Sebelumnya</a><a class="link" href="./briefs/">Arsip</a></div>',
    '  <div class="audit"><b>Audit passed</b> · Dibantu AI, diverifikasi sumber, dan bertanggung jawab editorial. Setiap edisi melewati quality review internal sebelum publikasi.</div>',
    '</div>',
    '<aside class="latest"><div class="k">Latest Brief</div><h2><a id="latest-title" href="' + latestHref + '">' + escapeHtml(latestTitle) + '</a></h2><p id="latest-dek">' + escapeHtml(latestDek) + '</p><div class="note" id="note">' + latestNote + '</div>' + (recentLinks ? '<div class="recent"><div class="k">Edisi terbaru lain</div><ul id="recent-list">' + recentLinks + '</ul></div>' : '') + '</aside>',
    '</section>',
    '<section class="context"><div class="k">Executive context</div><div class="context-grid"><div><b>BI Rate</b><span>Cost of capital</span><small>RDG watch</small></div><div><b>Inflasi</b><span>Pricing power</span><small>BPS release</small></div><div><b>USD/IDR</b><span>FX exposure</span><small>Hedging trigger</small></div><div><b>APBN/SBN</b><span>Fiscal room</span><small>Funding signal</small></div><div><b>Energi</b><span>Input cost</span><small>ICP / offtake</small></div></div></section>',
    '<section class="proof"><div><h3>Board question</h3><p>Satu pertanyaan yang layak masuk agenda Direksi atau komite risiko.</p></div><div><h3>Decision lens</h3><p>Setiap sinyal diterjemahkan ke owner, horizon, outcome, dan trigger eskalasi.</p></div><div><h3>Source discipline</h3><p>Brief memakai sumber publik yang dapat diperiksa, dengan audit sebelum publikasi.</p></div><div><h3>Premium path</h3><p>Memo mingguan, watchlist sektor, briefing khusus, dan board pack untuk tim.</p></div></section>',
    '</main>',
    '<footer class="foot">LeaderBrief.id · AI-assisted · Source-verified · Editorially accountable</footer>',
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
    "      var prev = document.getElementById('previous');",
    "      if (prev && keys[1]) { prev.href = './briefs/' + m[keys[1]].file; }",
    "      var t = document.getElementById('latest-title');",
    "      var dk = document.getElementById('latest-dek');",
    "      var sd = document.getElementById('status-date');",
    "      if (t) { t.href = './briefs/' + m[latest].file; t.textContent = (m[latest].title || m[latest].headline || 'Brief terbaru').replace(/^\\S+,\\s+\\d+\\s+\\S+\\s+\\d+\\s+[—-]\\s+/, ''); }",
    "      if (dk && m[latest].dek) dk.textContent = m[latest].dek;",
    "      if (sd) sd.textContent = pretty;",
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
    '<title>Paket Premium | LeaderBrief.id</title>',
    '<meta name="description" content="Paket premium dan korporasi LeaderBrief.id untuk board intelligence, sponsor, dan briefing khusus pemimpin Indonesia.">',
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
    '<header><a class="brand" href="./">LeaderBrief.id</a><nav><a href="./briefs/">Arsip</a><a href="./methodology.html">Metodologi</a><a href="./">Beranda</a></nav></header>',
    '<main>',
    '<h1>Board intelligence untuk keputusan yang tidak bisa menunggu.</h1>',
    '<p class="dek">LeaderBrief.id publik membangun kebiasaan baca harian. Paket premium mengubahnya menjadi memo eksekutif, sesi briefing, dan sponsor placement untuk audiens pemimpin Indonesia.</p>',
    '<div class="audit"><b>Workflow</b> · AI-assisted, source-verified, editorially accountable. Brief disusun dengan bantuan otomasi, lalu diperiksa untuk kutipan, duplikasi, sumber primer, dan ketajaman keputusan.</div>',
    '<div class="plans">',
    '<section class="plan"><h2>Individu</h2><p class="price">Rp149.000-299.000 per bulan</p><p>Untuk eksekutif yang membutuhkan arsip lengkap, memo mingguan, dan watchlist keputusan 7-30 hari.</p></section>',
    '<section class="plan"><h2>Korporasi</h2><p class="price">Rp2.500.000-7.500.000 per bulan</p><p>Untuk Direksi, komisaris, corporate strategy, risk, legal, dan transformation office yang perlu briefing sektor dan board pack.</p></section>',
    '<section class="plan"><h2>Sponsor</h2><p class="price">Paket bulanan</p><p>Untuk brand B2B yang ingin menjangkau pembaca pengambil keputusan melalui sponsor yang diberi label jelas dan menjaga kepercayaan editorial.</p></section>',
    '</div>',
    '<h3>Produk awal</h3>',
    '<ul><li>Weekly board memo dari seluruh edisi pekan berjalan.</li><li>Custom briefing untuk rapat Direksi, Komite Risiko, atau tim strategi.</li><li>Sector watch: energi, BUMN, AI, capital allocation, dan governance.</li><li>Sponsor slot dengan disclosure yang jelas.</li></ul>',
    '<section class="cta"><h3>Pilot 30 hari</h3><p>Mulai dari satu memo mingguan, satu sesi briefing, dan satu daftar tema prioritas. Setelah respons pembaca terlihat, paket bisa dinaikkan ke langganan korporasi atau sponsorship.</p><p><a class="btn" href="https://wa.me/6281393000399?text=Saya%20ingin%20diskusi%20paket%20premium%20LeaderBrief." rel="noopener" target="_blank">Diskusikan paket</a></p></section>',
    '</main><footer class="foot">LeaderBrief.id · AI-assisted · Source-verified · Editorially accountable</footer>',
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
    '<title>Metodologi | LeaderBrief.id</title>',
    '<meta name="description" content="Cara LeaderBrief.id menggunakan AI, sumber publik, audit kutipan, dan tanggung jawab editorial sebelum publikasi.">',
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
    '<header><a class="brand" href="./">LeaderBrief.id</a><nav><a href="./briefs/">Arsip</a><a href="./premium.html">Premium</a><a href="./">Beranda</a></nav></header>',
    '<main>',
    '<h1>Metodologi dan penggunaan AI.</h1>',
    '<p class="dek">LeaderBrief.id memakai AI sebagai alat kerja editorial, bukan sebagai otoritas final. Nilai produk berada pada pemilihan sumber, struktur keputusan, dan audit sebelum publikasi.</p>',
    '<div class="audit"><b>Principle</b> · AI-assisted, source-verified, editorially accountable.</div>',
    '<h2>Bagaimana brief disusun</h2>',
    '<p>Runner mengumpulkan kandidat dari sumber publik, RSS, dan pencarian. Model bahasa membantu menyusun draf berdasarkan materi yang diberikan runner. Draf kemudian dipaksa mengikuti struktur board-grade: fakta, inferensi, implikasi keputusan, owner, horizon, outcome, dan escalation trigger.</p>',
    '<h2>Apa yang diaudit</h2>',
    '<ul><li>Setiap edisi disusun dari sumber publik yang dapat ditelusuri.</li><li>Analisis melewati quality review internal sebelum publikasi.</li><li>Standar editorial menekankan akurasi, relevansi, konteks, dan kejelasan implikasi keputusan.</li><li>Keputusan investasi, hukum, dan teknis tetap menjadi tanggung jawab pembaca.</li></ul>',
    '<h2>Akuntabilitas</h2>',
    '<p>Kami tidak menyamarkan otomasi sebagai tulisan manusia murni. Kami juga tidak menyerahkan keputusan editorial kepada model. LeaderBrief.id adalah produk editorial berbasis sumber publik yang dibantu AI dan diperiksa sebelum terbit.</p>',
    '</main><footer class="foot">LeaderBrief.id · AI-assisted · Source-verified · Editorially accountable</footer>',
    '</div></body></html>',
    ''
  ].join('\n');
  writeFileSync(join(REPO, 'methodology.html'), html, 'utf8');
}

function injectTemplate(html, meta) {
  const css = readFileSync(join(__dirname, 'template.css'), 'utf8');
  const styleTag = '<style>\n' + css + '\n</style>';
  const pageTitle = (meta && (meta.lens || meta.dek)) ? escapeHtml((meta.lens || meta.dek).slice(0, 90)) + ' | LeaderBrief.id' : pretty + ' | LeaderBrief.id';
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
  const aside = '<aside class="aside"><div class="box"><div class="k">Edisi</div><p><strong>' + pretty + '</strong></p><p>Terbit setiap hari kerja pukul 05:30 WIB.</p></div><div class="box"><div class="k">Boardroom rail</div><ul><li><strong>Pertanyaan dewan:</strong> keputusan apa yang harus dipercepat, ditunda, atau diuji ulang?</li><li><strong>Aksi minggu ini:</strong> minta owner, horizon, dan trigger eskalasi untuk sinyal utama.</li><li><strong>Jendela risiko:</strong> pantau dampak 7-30 hari terhadap modal, izin, offtake, dan reputasi.</li></ul></div><div class="box"><div class="k">Audit</div><p>AI-assisted, source-verified, editorially accountable.</p><p>Setiap edisi melewati quality review internal sebelum publikasi.</p></div><div class="box"><div class="k">Navigasi</div><p><a href="../briefs/">Lihat arsip edisi</a></p><p><a href="../premium.html">Paket premium</a></p><p><a href="../methodology.html">Metodologi</a></p><p><a href="../">Beranda LeaderBrief.id</a></p></div></aside>';
  html = html.replace(/<body[^>]*>/, '<body>\n<div class="layout">\n' + toc + tocMobile);
  html = html.replace(/<\/body>/, editionSwitchHtml(dateStr) + aside + '\n</div>\n</body>');
  return html;
}

async function main() {
  mkdirSync(BRIEFS, { recursive: true });
  const promptText = readFileSync(join(__dirname, 'prompt.md'), 'utf8');
  console.log('gathering...');
  const items = await gather();
  const news = material(items);
  let html = '';
  let meta = {};
  let lastAudit = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log('calling deepseek... attempt ' + attempt);
    const repairNote = lastAudit
      ? '\n\n=== HASIL AUDIT DRAFT SEBELUMNYA ===\n' + lastAudit + '\nTulis ulang dari awal. Jangan ulangi frasa atau struktur yang ditolak audit. Buka setiap bagian dengan fakta, entitas, keputusan, angka, atau tanggal yang spesifik.'
      : '';
    const draft = await callDeepSeek(promptText + repairNote, news);
    const draftMeta = extractMeta(draft);
    const dressed = normalizeAuditLanguage(addChrome(injectTemplate(draft, draftMeta)));
    try {
      auditLeaderBrief(dressed);
      const visualPath = await writeExecutiveDecisionMap(dressed, draftMeta);
      html = injectVisualSeo(injectExecutiveDecisionMap(dressed, visualPath), visualPath);
      meta = extractMeta(html);
      break;
    } catch (e) {
      if (!(e instanceof AuditError) || attempt === 3) throw e;
      lastAudit = e.message;
      console.error('audit rejected attempt ' + attempt + ': ' + e.message);
    }
  }
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
