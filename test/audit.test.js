import test from 'node:test';
import assert from 'node:assert/strict';

import { auditLeaderBrief } from '../src/audit.js';

const valid = `
<html><body>
  <article>
    <p>Menteri Keuangan Purbaya Yudhi Sadewa menyatakan Danantara masih memprotes setoran Rp120 triliun.</p>
    <div class="coverage"><div class="blk-k">Basis coverage</div><ul><li><b>Coverage utama:</b> Finance & Capital</li><li><b>Coverage sekunder:</b> Governance & Decision Rights</li><li><b>Basis pemilihan:</b> setoran Rp120 triliun mengubah ruang kas dan mandat pemegang saham.</li><li><b>Keputusan leader yang terdampak:</b> CFO perlu memperbarui cash buffer dalam 30 hari.</li><li><b>Kenapa bukan coverage lain:</b> isu operasional tidak menjadi pemicu utama.</li></ul></div>
    <div class="field"><span>Action</span><p>Owner: CFO. Horizon: 30 hari. Outcome: proyeksi kas diperbarui. Escalation trigger: jika setoran berubah.</p></div>
  </article>
</body></html>`;

test('audit accepts sourced role and complete action ladder', () => {
  assert.doesNotThrow(() => auditLeaderBrief(valid));
});

test('audit rejects protected role mismatch', () => {
  assert.throws(
    () => auditLeaderBrief(valid.replace('Menteri Keuangan', 'Kepala Danantara')),
    /protected role mismatch/
  );
});

test('audit rejects empty recommendations', () => {
  assert.throws(
    () => auditLeaderBrief(valid.replace('Owner: CFO. Horizon: 30 hari. Outcome: proyeksi kas diperbarui. Escalation trigger: jika setoran berubah.', 'Hal ini perlu diperhatikan oleh seluruh stakeholder.')),
    /empty recommendation|action ladder incomplete/
  );
});

test('audit rejects em dash', () => {
  assert.throws(
    () => auditLeaderBrief(valid.replace('menyatakan Danantara', 'menyatakan — Danantara')),
    /em dash/
  );
});

test('audit rejects missing coverage basis', () => {
  assert.throws(
    () => auditLeaderBrief(valid.replace(/<div class="coverage">[\s\S]*?<\/div>\s*<div class="field">/, '<div class="field">')),
    /coverage basis incomplete/
  );
});
