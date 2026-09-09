import test from 'node:test';
import assert from 'node:assert/strict';

import { auditLeaderBrief } from '../src/audit.js';

const valid = `
<html><body>
  <article>
    <p>Menteri Keuangan Purbaya Yudhi Sadewa menyatakan Danantara masih memprotes setoran Rp120 triliun.</p>
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
