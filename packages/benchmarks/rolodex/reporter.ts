/**
 * Reporter v2 — full trace output with color, per-item verdict.
 */
import type { Metrics, ItemTrace, RelationshipMetrics, Conversation, Extraction } from './types';

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

export function header(t: string) { console.log(`\n${'═'.repeat(90)}\n  ${B}${t}${X}\n${'═'.repeat(90)}\n`); }

export function printConvTrace(conv: Conversation, ext: Extraction, idItems: ItemTrace[], relItems: ItemTrace[], trustItems: ItemTrace[]) {
  console.log(`  ┌── ${B}${conv.id}${X}: ${conv.name} [${conv.platform}/${conv.room}]`);

  // Messages
  for (const m of conv.messages) console.log(`  │ ${D}[${m.displayName}]${X} ${m.text.substring(0, 100)}`);

  // Handler traces
  if (ext.traces.length > 0) {
    console.log(`  │`);
    for (const t of ext.traces) console.log(`  │ ${D}→ ${t}${X}`);
  }

  // Identities
  const allIdItems = [...idItems];
  if (conv.expected.identities.length > 0 || ext.identities.length > 0) {
    console.log(`  │`);
    console.log(`  │ ${B}Identities${X}  expected: ${conv.expected.identities.length}  got: ${ext.identities.length}`);
    for (const item of allIdItems) {
      const icon = item.status === 'TP' ? `${G}✓${X}` : `${R}✗ ${item.status}${X}`;
      console.log(`  │   ${icon} ${item.label} ${D}${item.detail}${X}`);
    }
  }

  // Relationships
  if (conv.expected.relationships.length > 0 || ext.relationships.length > 0) {
    console.log(`  │`);
    console.log(`  │ ${B}Relationships${X}  expected: ${conv.expected.relationships.length}  got: ${ext.relationships.length}`);
    for (const item of relItems) {
      const icon = item.status === 'TP' ? `${G}✓${X}` : item.status === 'PARTIAL' ? `${Y}~ PARTIAL${X}` : `${R}✗ ${item.status}${X}`;
      console.log(`  │   ${icon} ${item.label} ${D}${item.detail}${X}`);
    }
  }

  // Trust
  if (conv.expected.trustSignals.length > 0 || ext.trustSignals.length > 0) {
    console.log(`  │`);
    console.log(`  │ ${B}Trust${X}  expected: ${conv.expected.trustSignals.length}  got: ${ext.trustSignals.length}`);
    for (const item of trustItems) {
      const icon = item.status === 'TP' ? `${G}✓${X}` : `${R}✗ ${item.status}${X}`;
      console.log(`  │   ${icon} ${item.label} ${D}${item.detail}${X}`);
    }
  }

  console.log(`  └──\n`);
}

export function printMetric(label: string, m: Metrics, extra?: string) {
  const status = m.f1 === 1 ? `${G}PERFECT${X}` : m.f1 >= 0.8 ? `${Y}GOOD${X}` : `${R}NEEDS WORK${X}`;
  const e = extra ? `  ${extra}` : '';
  console.log(`  ${label.padEnd(28)} P:${pct(m.precision).padStart(7)}  R:${pct(m.recall).padStart(7)}  F1:${pct(m.f1).padStart(7)}  (TP:${m.tp} FP:${m.fp} FN:${m.fn})  ${status}${e}`);
}

export function printRelMetric(label: string, m: RelationshipMetrics) {
  printMetric(label, m, `TypeAccuracy: ${pct(m.typeAccuracy)}`);
}

export function printResolutionTrace(items: ItemTrace[], traces: string[], fmr: number) {
  console.log(`  ┌── ${B}Entity Resolution${X}`);
  if (traces.length > 0) {
    for (const t of traces) console.log(`  │ ${D}→ ${t}${X}`);
    console.log(`  │`);
  }
  for (const item of items) {
    const icon = item.status === 'TP' ? `${G}✓${X}` : `${R}✗ ${item.status}${X}`;
    console.log(`  │ ${icon} ${item.label} ${D}${item.detail}${X}`);
  }
  console.log(`  │ False Merge Rate: ${pct(fmr)}`);
  console.log(`  └──\n`);
}

export function printComparison(handlers: Array<{ name: string; idF1: number; relF1: number; trF1: number; resF1: number; fmr: number; typeAcc: number; ms: number }>) {
  header('COMPARISON');
  const h = '  ' + 'Handler'.padEnd(28) + 'Identity'.padEnd(10) + 'Relation'.padEnd(10) + 'Trust'.padEnd(10) + 'Resolve'.padEnd(10) + 'FMR'.padEnd(8) + 'TypeAcc'.padEnd(10) + 'Time';
  console.log(h);
  console.log('  ' + '─'.repeat(95));
  for (const c of handlers) {
    console.log('  ' + c.name.substring(0, 27).padEnd(28) + pct(c.idF1).padEnd(10) + pct(c.relF1).padEnd(10) + pct(c.trF1).padEnd(10) + pct(c.resF1).padEnd(10) + pct(c.fmr).padEnd(8) + pct(c.typeAcc).padEnd(10) + `${c.ms.toFixed(1)}ms`);
  }
  console.log('');
}

function pct(n: number): string { return `${(n * 100).toFixed(1)}%`; }


