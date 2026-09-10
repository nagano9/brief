const STYLE_RULES = [
  {
    name: 'em dash',
    pattern: /—/,
    fix: 'replace em dashes with commas, colons, semicolons, or separate sentences'
  },
  {
    name: 'generic filler',
    pattern: /\b(?:di tengah dinamika|dalam lanskap|di era|seiring dengan perkembangan|implikasinya jelas|ke depan)\b/i,
    fix: 'open with the concrete development, entity, decision, or number'
  },
  {
    name: 'empty recommendation',
    pattern: /\b(?:perlu diperhatikan|perlu diantisipasi|harus terus dipantau|menjadi perhatian bersama|stakeholder perlu bersinergi)\b/i,
    fix: 'write an owner, horizon, outcome, and escalation trigger'
  }
];

const ROLE_MISMATCHES = [
  {
    person: /purbaya(?:\s+yudhi\s+sadewa)?/i,
    wrongRole: /\b(danantara\s+ceo|ceo\s+danantara|kepala\s+danantara|kepala\s+bp\s+bumn|pimpinan\s+danantara)\b/i,
    expected: 'Purbaya Yudhi Sadewa is Finance Minister, not Danantara leadership'
  }
];

export class AuditError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuditError';
  }
}

export function stripTagsForAudit(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function auditLeaderBrief(html) {
  const text = stripTagsForAudit(html);
  const failures = [];

  for (const rule of STYLE_RULES) {
    if (rule.pattern.test(text)) {
      failures.push(rule.name + ': ' + rule.fix);
    }
  }

  for (const rule of ROLE_MISMATCHES) {
    if (rule.person.test(text) && rule.wrongRole.test(text)) {
      failures.push('protected role mismatch: ' + rule.expected);
    }
  }

  if (!/\bOwner\s*:/i.test(text) || !/\bHorizon\s*:/i.test(text) || !/\bEscalation trigger\s*:/i.test(text)) {
    failures.push('action ladder incomplete: include Owner, Horizon, and Escalation trigger');
  }

  if (failures.length > 0) {
    throw new AuditError('LeaderBrief audit failed: ' + failures.join('; '));
  }
}

export function auditInstruction() {
  return [
    'AUDIT GATE WAJIB:',
    '- Jangan menebak jabatan dari konteks topik. Orang yang membahas Danantara tidak otomatis pejabat Danantara.',
    '- Jabatan seperti CEO, menteri, dirut, chairman, gubernur, ketua, atau kepala lembaga hanya boleh ditulis bila materi riset eksplisit menyebutkannya.',
    '- Purbaya Yudhi Sadewa adalah Menteri Keuangan. Jangan sebut sebagai CEO Danantara, Kepala Danantara, Kepala BP BUMN, atau pimpinan Danantara.',
    '- Setiap Action harus punya Owner, Horizon, Outcome, dan Escalation trigger.',
    '- Jangan memakai pembuka generik seperti di tengah dinamika, dalam lanskap, di era, seiring dengan perkembangan, implikasinya jelas, atau ke depan.',
    '- Buka paragraf penting dengan fakta konkret: nama entitas, angka, tanggal, keputusan, atau perubahan yang bisa diverifikasi.',
    '- Hindari rekomendasi kosong seperti perlu diperhatikan, perlu diantisipasi, terus dipantau, atau stakeholder perlu bersinergi.'
  ].join('\n');
}
