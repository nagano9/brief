import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CronExpressionParser } from 'cron-parser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function loadConfig() {
  return JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
}

function loadEnv() {
  const envPath = join(ROOT, '.env');
  const env = {};
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq > 0) {
        const k = t.slice(0, eq).trim();
        let v = t.slice(eq + 1).trim();
        v = v.replace(/^["']/, '').replace(/["']$/, '');
        env[k] = v;
      }
    }
  }
  return env;
}

function resolveApiKey(cfg, env) {
  let v = (cfg.deepseek && cfg.deepseek.apiKey) || '';
  if (v.startsWith('env:')) {
    const name = v.slice(4);
    v = process.env[name] || env[name] || '';
  }
  if (!v) v = process.env.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY || '';
  return v;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function fmtDate(d, pattern) {
  const yyyy = String(d.getFullYear());
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return pattern
    .split('{datetime}').join(yyyy + '-' + mm + '-' + dd + '_' + hh + mi)
    .split('{date}').join(yyyy + '-' + mm + '-' + dd)
    .split('{time}').join(hh + mi)
    .split('{year}').join(yyyy)
    .split('{month}').join(mm)
    .split('{day}').join(dd);
}

function loadState() {
  const p = join(ROOT, 'state.json');
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(s) {
  writeFileSync(join(ROOT, 'state.json'), JSON.stringify(s, null, 2) + '\n', 'utf8');
}

function nextOccurrence(cron, after, tz) {
  const interval = CronExpressionParser.parse(cron, { currentDate: after, tz });
  return interval.next().toDate();
}

async function callDeepSeek(cfg, key, messages, temperature) {
  const baseUrl = (cfg.deepseek && cfg.deepseek.baseUrl) || 'https://api.deepseek.com';
  const model = (cfg.deepseek && cfg.deepseek.model) || 'deepseek-chat';
  const timeoutMs = (cfg.deepseek && cfg.deepseek.timeoutMs) || 120000;
  const res = await fetch(baseUrl + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + key
    },
    body: JSON.stringify({ model, messages, temperature: temperature ?? 0.7, stream: false }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('DeepSeek API HTTP ' + res.status + ': ' + body.slice(0, 500));
  }
  const data = await res.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

function buildOutputPath(tpl, cfg, now, id) {
  let p = tpl.outputFile || (id + '/{date}-' + id + '.md');
  p = fmtDate(now, p).split('{id}').join(id);
  if (!p.toLowerCase().endsWith('.md')) p += '.md';
  return join(ROOT, cfg.outputDir || 'output', p);
}

async function generateTemplate(tpl, id, cfg, key, now, dryRun) {
  const system = tpl.systemPrompt || 'Anda adalah asisten penulis konten profesional.';
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: tpl.prompt }
  ];
  if (dryRun) {
    const model = (cfg.deepseek && cfg.deepseek.model) || 'deepseek-chat';
    console.log('[dry-run] ' + id + ' -> model "' + model + '"');
    console.log('[dry-run] prompt:\n---\n' + tpl.prompt + '\n---');
    return null;
  }
  const content = await callDeepSeek(cfg, key, messages, tpl.temperature);
  const outPath = buildOutputPath(tpl, cfg, now, id);
  mkdirSync(dirname(outPath), { recursive: true });
  const model = (cfg.deepseek && cfg.deepseek.model) || 'deepseek-chat';
  const header = '# ' + (tpl.title || id) + '\n\n> Template: ' + id + ' · Dibuat: ' + now.toISOString() + ' · Model: ' + model + '\n\n';
  writeFileSync(outPath, header + content + '\n', 'utf8');
  console.log('[ok] ' + id + ' -> ' + outPath);
  return outPath;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const positional = args.filter((a) => !a.startsWith('--'));
  return { flags, positional };
}

async function main() {
  const cfg = loadConfig();
  const env = loadEnv();
  const tz = cfg.timezone || 'Asia/Jakarta';
  const key = resolveApiKey(cfg, env);
  const parsed = parseArgs();
  const now = new Date();
  const templates = cfg.templates || [];
  const byId = {};
  for (const t of templates) byId[t.id] = t;

  if (parsed.flags.has('--list')) {
    const state = loadState();
    for (const t of templates) {
      const st = state[t.id];
      const prefix = t.enabled === false ? '[OFF] ' : '';
      if (st && st.nextRunAt) {
        const next = new Date(st.nextRunAt);
        console.log('- ' + prefix + t.id + ' (' + t.cron + ')  next: ' + next.toLocaleString('id-ID', { timeZone: tz }));
      } else {
        console.log('- ' + prefix + t.id + ' (' + t.cron + ')  next: belum dijadwalkan');
      }
    }
    return;
  }

  if (parsed.flags.has('--now')) {
    const target = parsed.positional[0];
    if (!target) {
      console.error('Gunakan: node src/run.js --now <templateId>');
      process.exit(1);
    }
    const tpl = byId[target];
    if (!tpl) {
      console.error('Template "' + target + '" tidak ditemukan di config.json.');
      process.exit(1);
    }
    const dry = parsed.flags.has('--dry-run');
    if (!dry && !key) {
      console.error('API key DeepSeek belum diatur. Set env DEEPSEEK_API_KEY atau buat file .env.');
      process.exit(1);
    }
    await generateTemplate(tpl, target, cfg, key, now, dry);
    return;
  }

  // Tick terjadwal (dipanggil oleh Windows Task Scheduler)
  const dry = parsed.flags.has('--dry-run');
  const state = loadState();
  let changed = false;

  for (const t of templates) {
    if (t.enabled === false) continue;
    const id = t.id;
    if (!state[id]) state[id] = {};
    const st = state[id];
    if (!st.nextRunAt) {
      st.nextRunAt = nextOccurrence(t.cron, now, tz).toISOString();
      changed = true;
    }
    const next = new Date(st.nextRunAt);
    if (next <= now) {
      if (dry) {
        console.log('[due] ' + id + ' (' + t.cron + ') -> ' + buildOutputPath(t, cfg, now, id));
        continue;
      }
      if (!key) {
        console.error('[error] ' + id + ': API key belum diatur, skip.');
        continue;
      }
      try {
        await generateTemplate(t, id, cfg, key, now, false);
        st.nextRunAt = nextOccurrence(t.cron, now, tz).toISOString();
        st.lastRunAt = now.toISOString();
        changed = true;
      } catch (e) {
        console.error('[error] ' + id + ': ' + e.message);
      }
    }
  }

  if (changed) saveState(state);
  console.log('Tick selesai pada ' + now.toISOString() + '.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
