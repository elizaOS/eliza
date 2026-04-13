/**
 * Scorer v2 — with relationship type accuracy and full item traces.
 */
import type { Metrics, ItemTrace, RelationshipMetrics, Conversation, Extraction, Resolution, GroundTruthWorld } from './types';

export function m(tp: number, fp: number, fn: number): Metrics {
  const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { tp, fp, fn, precision, recall, f1 };
}

function norm(h: string): string { return h.replace(/^@/, '').toLowerCase().trim(); }

export function scoreIdentities(
  conv: Conversation, ext: Extraction
): { metrics: Metrics; items: ItemTrace[] } {
  const exp = conv.expected.identities;
  const act = ext.identities;
  const items: ItemTrace[] = [];
  const matched = new Set<number>();

  for (const a of act) {
    const idx = exp.findIndex((e, i) =>
      !matched.has(i) && e.entityId === a.entityId && e.platform === a.platform && norm(e.handle) === norm(a.handle)
    );
    if (idx >= 0) {
      matched.add(idx);
      items.push({ status: 'TP', label: `${a.entityId}/${a.platform}:${a.handle}`, detail: 'Match' });
    } else {
      items.push({ status: 'FP', label: `${a.entityId}/${a.platform}:${a.handle}`, detail: 'Extra' });
    }
  }
  for (let i = 0; i < exp.length; i++) {
    if (!matched.has(i)) {
      items.push({ status: 'FN', label: `${exp[i].entityId}/${exp[i].platform}:${exp[i].handle}`, detail: 'Missed' });
    }
  }
  return { metrics: m(items.filter(i => i.status === 'TP').length, items.filter(i => i.status === 'FP').length, items.filter(i => i.status === 'FN').length), items };
}

export function scoreRelationships(
  conv: Conversation, ext: Extraction
): { metrics: RelationshipMetrics; items: ItemTrace[] } {
  const exp = conv.expected.relationships;
  const act = ext.relationships;
  const items: ItemTrace[] = [];
  const matched = new Set<number>();
  let typeMatches = 0;
  let totalMatches = 0;

  for (const a of act) {
    const idx = exp.findIndex((e, i) =>
      !matched.has(i) &&
      ((e.entityA === a.entityA && e.entityB === a.entityB) || (e.entityA === a.entityB && e.entityB === a.entityA))
    );
    if (idx >= 0) {
      matched.add(idx);
      totalMatches++;
      const typeOk = exp[idx].type === a.type;
      if (typeOk) typeMatches++;
      items.push({
        status: typeOk ? 'TP' : 'PARTIAL',
        label: `${a.entityA}<->${a.entityB} [${a.type}]`,
        detail: typeOk ? 'Match' : `Pair correct, type wrong (expected: ${exp[idx].type}, got: ${a.type})`,
      });
    } else {
      items.push({ status: 'FP', label: `${a.entityA}<->${a.entityB} [${a.type}]`, detail: 'Extra' });
    }
  }
  for (let i = 0; i < exp.length; i++) {
    if (!matched.has(i)) {
      items.push({ status: 'FN', label: `${exp[i].entityA}<->${exp[i].entityB} [${exp[i].type}]`, detail: 'Missed' });
    }
  }

  const tp = items.filter(i => i.status === 'TP' || i.status === 'PARTIAL').length;
  const fp = items.filter(i => i.status === 'FP').length;
  const fn = items.filter(i => i.status === 'FN').length;
  const typeAccuracy = totalMatches > 0 ? typeMatches / totalMatches : 1;

  return { metrics: { ...m(tp, fp, fn), typeAccuracy }, items };
}

export function scoreTrust(
  conv: Conversation, ext: Extraction
): { metrics: Metrics; items: ItemTrace[] } {
  const exp = conv.expected.trustSignals;
  const act = ext.trustSignals;
  const items: ItemTrace[] = [];
  const matched = new Set<number>();

  for (const a of act) {
    const idx = exp.findIndex((e, i) => !matched.has(i) && e.entityId === a.entityId && e.signal === a.signal);
    if (idx >= 0) {
      matched.add(idx);
      items.push({ status: 'TP', label: `${a.entityId}:${a.signal}`, detail: 'Match' });
    } else {
      items.push({ status: 'FP', label: `${a.entityId}:${a.signal}`, detail: 'Extra' });
    }
  }
  for (let i = 0; i < exp.length; i++) {
    if (!matched.has(i)) {
      items.push({ status: 'FN', label: `${exp[i].entityId}:${exp[i].signal}`, detail: 'Missed' });
    }
  }
  return { metrics: m(items.filter(i => i.status === 'TP').length, items.filter(i => i.status === 'FP').length, items.filter(i => i.status === 'FN').length), items };
}

export function scoreResolution(
  world: GroundTruthWorld, res: Resolution
): { metrics: Metrics; falseMergeRate: number; items: ItemTrace[] } {
  const items: ItemTrace[] = [];
  const matchedLinks = new Set<number>();

  for (const prop of res.links) {
    const isAnti = world.antiLinks.some(al =>
      (al.entityA === prop.entityA && al.entityB === prop.entityB) || (al.entityA === prop.entityB && al.entityB === prop.entityA)
    );
    if (isAnti) {
      items.push({ status: 'FP', label: `${prop.entityA}<->${prop.entityB}`, detail: `FALSE MERGE (anti-link)` });
      continue;
    }
    const idx = world.links.findIndex((link, i) =>
      !matchedLinks.has(i) &&
      ((link.entityA === prop.entityA && link.entityB === prop.entityB) || (link.entityA === prop.entityB && link.entityB === prop.entityA))
    );
    if (idx >= 0) {
      matchedLinks.add(idx);
      items.push({ status: 'TP', label: `${prop.entityA}<->${prop.entityB} (${prop.confidence.toFixed(2)})`, detail: `Signals: ${prop.signals.join('; ')}` });
    } else {
      items.push({ status: 'FP', label: `${prop.entityA}<->${prop.entityB}`, detail: 'No ground truth link' });
    }
  }
  for (let i = 0; i < world.links.length; i++) {
    if (!matchedLinks.has(i)) {
      const link = world.links[i];
      items.push({ status: 'FN', label: `${link.entityA}<->${link.entityB}`, detail: `Missed [${link.difficulty}]: ${link.reason}` });
    }
  }
  const tp = items.filter(i => i.status === 'TP').length;
  const fp = items.filter(i => i.status === 'FP').length;
  const fn = items.filter(i => i.status === 'FN').length;
  return { metrics: m(tp, fp, fn), falseMergeRate: tp + fp > 0 ? fp / (tp + fp) : 0, items };
}
