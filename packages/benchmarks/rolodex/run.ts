#!/usr/bin/env bun
/**
 * Rolodex Benchmark v2 — realistic handles, noise, type accuracy, full traces.
 *
 * Usage:
 *   bun run benchmarks/rolodex/run.ts              # runs perfect + rolodex
 *   bun run benchmarks/rolodex/run.ts --eliza       # runs perfect + rolodex + eliza (LLM)
 */

import { WORLD } from './world';
import { CONVERSATIONS } from './conversations';
import { perfectHandler } from './handlers/perfect';
import { rolodexHandler } from './handlers/rolodex';
import { scoreIdentities, scoreRelationships, scoreTrust, scoreResolution, m } from './scorer';
import { header, printConvTrace, printMetric, printRelMetric, printResolutionTrace, printComparison } from './reporter';
import type { Handler, Extraction, Metrics, RelationshipMetrics } from './types';

interface RunResult {
  identityM: Metrics;
  relM: RelationshipMetrics;
  trustM: Metrics;
  resM: Metrics;
  fmr: number;
  totalTime: number;
}

async function run(handler: Handler): Promise<RunResult> {
  if (handler.setup) await handler.setup();

  const extractions: Extraction[] = [];
  let idTp = 0, idFp = 0, idFn = 0;
  let relTp = 0, relFp = 0, relFn = 0;
  let trTp = 0, trFp = 0, trFn = 0;
  let typeMatches = 0, totalMatches = 0;

  for (const conv of CONVERSATIONS) {
    const ext = await handler.extract(conv, WORLD);
    extractions.push(ext);

    const id = scoreIdentities(conv, ext);
    const rel = scoreRelationships(conv, ext);
    const tr = scoreTrust(conv, ext);

    idTp += id.metrics.tp; idFp += id.metrics.fp; idFn += id.metrics.fn;
    relTp += rel.metrics.tp; relFp += rel.metrics.fp; relFn += rel.metrics.fn;
    trTp += tr.metrics.tp; trFp += tr.metrics.fp; trFn += tr.metrics.fn;

    // Type accuracy tracking
    typeMatches += rel.items.filter(i => i.status === 'TP').length;
    totalMatches += rel.items.filter(i => i.status === 'TP' || i.status === 'PARTIAL').length;

    printConvTrace(conv, ext, id.items, rel.items, tr.items);
  }

  const identityM = m(idTp, idFp, idFn);
  const relM: RelationshipMetrics = { ...m(relTp, relFp, relFn), typeAccuracy: totalMatches > 0 ? typeMatches / totalMatches : 1 };
  const trustM = m(trTp, trFp, trFn);

  printMetric('Identity Extraction', identityM);
  printRelMetric('Relationship Detection', relM);
  printMetric('Trust Detection', trustM);
  console.log('');

  const res = await handler.resolve(extractions, WORLD);
  const resSc = scoreResolution(WORLD, res);
  printResolutionTrace(resSc.items, res.traces, resSc.falseMergeRate);
  printMetric('Entity Resolution', resSc.metrics);
  console.log('');

  if (handler.teardown) await handler.teardown();

  const totalTime = extractions.reduce((s, e) => s + e.wallTimeMs, 0) + res.wallTimeMs;
  return { identityM, relM, trustM, resM: resSc.metrics, fmr: resSc.falseMergeRate, totalTime };
}

async function main() {
  const useEliza = process.argv.includes('--eliza');

  header('ROLODEX BENCHMARK v2');
  console.log(`  World: ${WORLD.entities.length} entities, ${WORLD.links.length} cross-platform links, ${WORLD.antiLinks.length} anti-links`);
  console.log(`  Conversations: ${CONVERSATIONS.length} (${CONVERSATIONS.filter(c => c.expected.identities.length === 0 && c.expected.relationships.length === 0 && c.expected.trustSignals.length === 0).length} noise)\n`);

  // Perfect handler
  header('PERFECT HANDLER (Validation)');
  const perfect = await run(perfectHandler);

  const ok = perfect.identityM.f1 === 1 && perfect.relM.f1 === 1 && perfect.trustM.f1 === 1 && perfect.resM.f1 === 1 && perfect.fmr === 0;
  if (ok) {
    console.log(`  \x1b[32m✓ VALIDATION PASSED: Perfect handler = 100% everywhere.\x1b[0m\n`);
  } else {
    console.log(`  \x1b[31m✗ VALIDATION FAILED! Bug in scoring.\x1b[0m\n`);
    process.exit(1);
  }

  // Rolodex handler
  header('ROLODEX HANDLER (System Under Test)');
  const rolodex = await run(rolodexHandler);

  // Comparison entries
  const comparisonEntries = [
    { name: 'Perfect (Oracle)', idF1: perfect.identityM.f1, relF1: perfect.relM.f1, trF1: perfect.trustM.f1, resF1: perfect.resM.f1, fmr: perfect.fmr, typeAcc: perfect.relM.typeAccuracy, ms: perfect.totalTime },
    { name: 'Rolodex (Algorithmic)', idF1: rolodex.identityM.f1, relF1: rolodex.relM.f1, trF1: rolodex.trustM.f1, resF1: rolodex.resM.f1, fmr: rolodex.fmr, typeAcc: rolodex.relM.typeAccuracy, ms: rolodex.totalTime },
  ];

  // Eliza handler (optional, LLM-based)
  let elizaResult: RunResult | null = null;
  if (useEliza) {
    const { elizaHandler } = await import('./handlers/eliza');
    header('ELIZA HANDLER (LLM via AgentRuntime)');
    elizaResult = await run(elizaHandler);
    comparisonEntries.push({
      name: 'Eliza (LLM)', idF1: elizaResult.identityM.f1, relF1: elizaResult.relM.f1, trF1: elizaResult.trustM.f1, resF1: elizaResult.resM.f1, fmr: elizaResult.fmr, typeAcc: elizaResult.relM.typeAccuracy, ms: elizaResult.totalTime,
    });
  }

  // Comparison
  printComparison(comparisonEntries);

  // Verdict
  const sutResult = elizaResult ?? rolodex;
  const sutName = elizaResult ? 'Eliza' : 'Rolodex';
  const allPerfect = sutResult.identityM.f1 === 1 && sutResult.relM.f1 === 1 && sutResult.trustM.f1 === 1 && sutResult.resM.f1 === 1 && sutResult.fmr === 0;
  header('VERDICT');
  if (allPerfect) {
    console.log(`  \x1b[32mALL SUITES AT 100%. ${sutName} verified at all difficulty levels.\x1b[0m`);
  } else {
    const scores = [sutResult.identityM.f1, sutResult.relM.f1, sutResult.trustM.f1, sutResult.resM.f1];
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    console.log(`  Average F1: ${(avg * 100).toFixed(1)}%  |  Resolution: ${(sutResult.resM.f1 * 100).toFixed(1)}%  |  FMR: ${(sutResult.fmr * 100).toFixed(1)}%`);
    if (sutResult.fmr > 0) console.log(`  \x1b[31mCRITICAL: False merges detected!\x1b[0m`);
    console.log(`  \x1b[33mGaps remain. Review traces above.\x1b[0m`);
  }
  console.log('');
}

main();
