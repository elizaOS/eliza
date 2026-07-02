/**
 * Scoring for the entity-from-voice benchmark.
 *
 * Pure functions over a lane-agnostic `SessionObservation` so the KG lane
 * (voice merge engine) and the LLM lane (message pipeline) are graded by
 * the same code. Definitions:
 *
 *   creation       P/R over person entities present at session end vs the
 *                  corpus' expected introductions (greedy 1:1 name match).
 *   recognition    P/R over turns that must bind to an existing entity:
 *                  predicted-positive = turns the system bound to an
 *                  existing entity; TP = bound to the RIGHT one.
 *   attribute      recall = expected (subject, keywords) facts matched by a
 *                  stored fact/attribute; precision = groundedness — of
 *                  stored person-facts, the fraction whose content words
 *                  trace back to something actually said in the session
 *                  (an anti-hallucination measure; the pipeline may
 *                  legitimately store true facts beyond ground truth).
 *   disambiguation P/R over confusable-turn claims: relationship edges and
 *                  re-bindings must land on the right one of the
 *                  similar-sounding entities; false merges counted.
 */

import type { BenchSession, BenchUtterance } from "./corpus.ts";

export interface ObservedEntity {
  entityId: string;
  name: string;
  /** Flattened `key: value` attribute strings. */
  attributes: string[];
}

export interface ObservedRelationship {
  toEntityId: string;
  /** Preferred name of the target entity (joined by the runner). */
  toName: string;
  /** Relationship type + label, e.g. "partner_of wife". */
  label: string;
}

export interface TurnOutcome {
  utteranceId: string;
  /** Transcript actually fed to the pipeline (reference or ASR). */
  transcript: string;
  /** Entity id the voice turn bound to (KG lane; undefined in LLM lane). */
  boundEntityId?: string;
  /** True when the binding minted a new entity. */
  wasCreated?: boolean;
}

export interface SessionObservation {
  sessionId: string;
  turns: TurnOutcome[];
  /** Person entities at session end, excluding the owner/self row. */
  entities: ObservedEntity[];
  /** Person-to-person edges from the owner/self at session end. */
  relationships: ObservedRelationship[];
  /** Stored fact texts (facts table rows and/or KG attribute strings). */
  facts: string[];
  /** speaker key -> entityId assigned at that speaker's creation turn. */
  speakerEntities: Record<string, string>;
}

export interface PrCell {
  tp: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface SessionScore {
  sessionId: string;
  creation: PrCell;
  recognition: PrCell;
  attribute: PrCell & { groundedFacts: number; personFacts: number };
  disambiguation: PrCell & { falseMerges: number };
  relationships: PrCell;
  details: string[];
}

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(text: string): string[] {
  return normalize(text).split(" ").filter(Boolean);
}

/** Name equality on normalized tokens, allowing subset ("Maria" ~ "Maria Chen"). */
export function nameMatches(expected: string, actual: string): boolean {
  const e = tokens(expected);
  const a = tokens(actual);
  if (e.length === 0 || a.length === 0) return false;
  const aSet = new Set(a);
  const eSet = new Set(e);
  return e.every((t) => aSet.has(t)) || a.every((t) => eSet.has(t));
}

function prCell(tp: number, fp: number, fn: number): PrCell {
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;
  return { tp, fp, fn, precision, recall, f1 };
}

/** Greedy 1:1 match of expected names to observed entities. */
export function scoreCreation(
  session: BenchSession,
  observation: SessionObservation,
  details: string[],
): PrCell {
  const expected = new Map<string, string>();
  for (const u of session.utterances) {
    if (u.expectCreates) expected.set(normalize(u.expectCreates), u.expectCreates);
  }
  const unmatchedObserved = [...observation.entities];
  let tp = 0;
  let fn = 0;
  for (const [, name] of expected) {
    const idx = unmatchedObserved.findIndex((e) => nameMatches(name, e.name));
    if (idx >= 0) {
      tp += 1;
      unmatchedObserved.splice(idx, 1);
    } else {
      fn += 1;
      details.push(`creation MISS: expected entity "${name}" not found`);
    }
  }
  for (const extra of unmatchedObserved) {
    details.push(
      `creation SPURIOUS: entity "${extra.name}" (${extra.entityId}) not expected`,
    );
  }
  return prCell(tp, unmatchedObserved.length, fn);
}

function bindingTurns(
  session: BenchSession,
  category: "recognition" | "disambiguation",
): BenchUtterance[] {
  return session.utterances.filter(
    (u) => u.category === category && u.expectBindsTo,
  );
}

/**
 * Score turns that must bind to an existing entity. `boundEntityId` is
 * undefined for lanes that do not bind (LLM lane) — those count as FN.
 */
export function scoreBindings(
  session: BenchSession,
  observation: SessionObservation,
  category: "recognition" | "disambiguation",
  details: string[],
): PrCell {
  const turnsById = new Map(observation.turns.map((t) => [t.utteranceId, t]));
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const u of bindingTurns(session, category)) {
    const outcome = turnsById.get(u.id);
    const expectedEntity = u.expectBindsTo
      ? observation.speakerEntities[u.expectBindsTo]
      : undefined;
    if (!outcome?.boundEntityId || outcome.wasCreated) {
      fn += 1;
      details.push(
        `${category} MISS: ${u.id} did not bind to an existing entity` +
          (outcome?.wasCreated ? " (created a duplicate)" : ""),
      );
      if (outcome?.wasCreated) fp += 1;
      continue;
    }
    if (expectedEntity && outcome.boundEntityId === expectedEntity) {
      tp += 1;
    } else {
      fp += 1;
      fn += 1;
      details.push(
        `${category} WRONG: ${u.id} bound to ${outcome.boundEntityId}, expected ${expectedEntity ?? "<unassigned>"}`,
      );
    }
  }
  return prCell(tp, fp, fn);
}

const STOPWORDS = new Set(
  "a an and are at by for from in is it my of on our please she he the they this to was we with you your can could".split(
    " ",
  ),
);

function contentWords(text: string): string[] {
  return tokens(text).filter((t) => !STOPWORDS.has(t) && t.length > 1);
}

/** True when the record's content words trace back to a session utterance. */
export function isGrounded(record: string, session: BenchSession): boolean {
  const words = contentWords(record);
  if (words.length === 0) return false;
  for (const u of session.utterances) {
    const uttWords = new Set(contentWords(u.text));
    const overlap = words.filter((w) => uttWords.has(w)).length;
    if (overlap / words.length >= 0.5) return true;
  }
  return false;
}

export function scoreAttributes(
  session: BenchSession,
  observation: SessionObservation,
  details: string[],
): PrCell & { groundedFacts: number; personFacts: number } {
  const expected = session.utterances
    .filter((u) => u.expectFact)
    .map((u) => u.expectFact as { subject: string; keywords: string[] });

  let tp = 0;
  let fn = 0;
  for (const fact of expected) {
    const subject = normalize(fact.subject);
    const hit = observation.facts.some((record) => {
      const norm = normalize(record);
      return (
        norm.includes(subject) &&
        fact.keywords.every((k) => norm.includes(normalize(k)))
      );
    });
    if (hit) tp += 1;
    else {
      fn += 1;
      details.push(
        `attribute MISS: no stored fact for subject "${fact.subject}" with keywords [${fact.keywords.join(", ")}]`,
      );
    }
  }

  // Precision = groundedness over person-facts (anti-hallucination).
  const personNames = new Set<string>();
  for (const u of session.utterances) {
    if (u.expectCreates) personNames.add(normalize(u.expectCreates));
  }
  for (const e of observation.entities) personNames.add(normalize(e.name));
  const personFacts = observation.facts.filter((record) => {
    const norm = normalize(record);
    return [...personNames].some((n) => n.length > 0 && norm.includes(n.split(" ")[0] ?? n));
  });
  let grounded = 0;
  for (const record of personFacts) {
    if (isGrounded(record, session)) grounded += 1;
    else details.push(`attribute UNGROUNDED: "${record.slice(0, 120)}"`);
  }
  const fp = personFacts.length - grounded;
  const precision = personFacts.length > 0 ? grounded / personFacts.length : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;
  return {
    tp,
    fp,
    fn,
    precision,
    recall,
    f1,
    groundedFacts: grounded,
    personFacts: personFacts.length,
  };
}

export function scoreRelationships(
  session: BenchSession,
  observation: SessionObservation,
  category: "all" | "disambiguation",
  details: string[],
): PrCell {
  const expected = session.utterances
    .filter(
      (u) =>
        u.expectRelationship &&
        (category === "all" || u.category === "disambiguation"),
    )
    .map((u) => u.expectRelationship as { toName: string; label: string });
  // De-dupe repeated claims of the same edge.
  const expectedUnique = expected.filter(
    (r, i) =>
      expected.findIndex(
        (o) =>
          normalize(o.toName) === normalize(r.toName) &&
          normalize(o.label) === normalize(r.label),
      ) === i,
  );

  const observed = [...observation.relationships];
  let tp = 0;
  let fn = 0;
  for (const rel of expectedUnique) {
    const idx = observed.findIndex(
      (o) =>
        nameMatches(rel.toName, o.toName) &&
        normalize(o.label).includes(normalize(rel.label)),
    );
    if (idx >= 0) {
      tp += 1;
      observed.splice(idx, 1);
    } else {
      fn += 1;
      details.push(
        `relationship MISS (${category}): self -[${rel.label}]-> "${rel.toName}"`,
      );
    }
  }
  // Only count leftover edges as FP when scoring the full set; the
  // disambiguation slice must not penalize edges owned by other turns.
  const fp = category === "all" ? observed.length : 0;
  for (const extra of category === "all" ? observed : []) {
    details.push(
      `relationship SPURIOUS: self -[${extra.label}]-> "${extra.toName}"`,
    );
  }
  return prCell(tp, fp, fn);
}

/** Distinct expected people folded into one entity id. */
export function countFalseMerges(
  session: BenchSession,
  observation: SessionObservation,
  details: string[],
): number {
  const byEntity = new Map<string, string[]>();
  for (const [speaker, entityId] of Object.entries(
    observation.speakerEntities,
  )) {
    const list = byEntity.get(entityId) ?? [];
    list.push(speaker);
    byEntity.set(entityId, list);
  }
  let merges = 0;
  for (const [entityId, speakers] of byEntity) {
    if (speakers.length > 1) {
      merges += speakers.length - 1;
      details.push(
        `FALSE MERGE: speakers [${speakers.join(", ")}] share entity ${entityId}`,
      );
    }
  }
  return merges;
}

export function scoreSession(
  session: BenchSession,
  observation: SessionObservation,
): SessionScore {
  const details: string[] = [];
  const creation = scoreCreation(session, observation, details);
  const recognition = scoreBindings(session, observation, "recognition", details);
  const attribute = scoreAttributes(session, observation, details);
  const disambBindings = scoreBindings(
    session,
    observation,
    "disambiguation",
    details,
  );
  const disambRelationships = scoreRelationships(
    session,
    observation,
    "disambiguation",
    details,
  );
  const falseMerges = countFalseMerges(session, observation, details);
  const disambiguation = {
    ...prCell(
      disambBindings.tp + disambRelationships.tp,
      disambBindings.fp + disambRelationships.fp + falseMerges,
      disambBindings.fn + disambRelationships.fn,
    ),
    falseMerges,
  };
  const relationships = scoreRelationships(session, observation, "all", details);
  return {
    sessionId: session.id,
    creation,
    recognition,
    attribute,
    disambiguation,
    relationships,
    details,
  };
}

export function aggregateCells(cells: PrCell[]): PrCell {
  const tp = cells.reduce((a, c) => a + c.tp, 0);
  const fp = cells.reduce((a, c) => a + c.fp, 0);
  const fn = cells.reduce((a, c) => a + c.fn, 0);
  return prCell(tp, fp, fn);
}

/** Word error rate — Levenshtein over normalized word tokens. */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const r = tokens(reference);
  const h = tokens(hypothesis);
  if (r.length === 0) return h.length === 0 ? 0 : 1;
  const d: number[][] = Array.from({ length: r.length + 1 }, () =>
    new Array<number>(h.length + 1).fill(0),
  );
  for (let i = 0; i <= r.length; i++) d[i]![0] = i;
  for (let j = 0; j <= h.length; j++) d[0]![j] = j;
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      d[i]![j] =
        r[i - 1] === h[j - 1]
          ? d[i - 1]![j - 1]!
          : 1 + Math.min(d[i - 1]![j - 1]!, d[i - 1]![j]!, d[i]![j - 1]!);
    }
  }
  return d[r.length]![h.length]! / r.length;
}

/** Fraction of expected proper names that survived ASR into the hypothesis. */
export function nameHitRate(
  expectedNames: string[],
  hypothesis: string,
): number | null {
  if (expectedNames.length === 0) return null;
  const norm = normalize(hypothesis);
  const hits = expectedNames.filter((n) =>
    n
      .split(/\s+/)
      .every((part) => norm.includes(normalize(part))),
  ).length;
  return hits / expectedNames.length;
}
