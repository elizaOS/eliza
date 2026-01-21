import type {
  Fact,
  FactEvidence,
  FactValue,
  IsoDateTime,
  Persona,
} from "./types";
import { clampNumber } from "./utils";

export interface FactInput {
  type: string;
  key: string;
  value: FactValue;
  confidence: number;
  evidence: FactEvidence[];
}

const valuesEqual = (a: FactValue, b: FactValue): boolean => {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, i) => value === b[i]);
  }
  return a === b;
};

const nextFactId = (persona: Persona, key: string): string => {
  const base = key.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return `fact-${persona.id}-${base}-${persona.facts.length + 1}`;
};

export const upsertFact = (
  persona: Persona,
  input: FactInput,
  now: IsoDateTime,
): Fact => {
  const existing = persona.facts.find(
    (fact) => fact.key === input.key && fact.status === "active",
  );

  if (existing && valuesEqual(existing.value, input.value)) {
    existing.confidence = clampNumber(
      Math.max(existing.confidence, input.confidence),
      0,
      1,
    );
    existing.updatedAt = now;

    for (const newEvidence of input.evidence) {
      const exists = existing.evidence.some(
        (e) =>
          e.conversationId === newEvidence.conversationId &&
          e.turnIds.length === newEvidence.turnIds.length &&
          e.turnIds.every((id, i) => id === newEvidence.turnIds[i]),
      );
      if (!exists) existing.evidence.push(newEvidence);
    }

    return existing;
  }

  if (existing) {
    if (input.confidence > existing.confidence) {
      existing.value = input.value;
      existing.confidence = clampNumber(input.confidence, 0, 1);
      existing.evidence = input.evidence;
      existing.updatedAt = now;
      return existing;
    }
    return existing;
  }

  const fact: Fact = {
    factId: nextFactId(persona, input.key),
    type: input.type,
    key: input.key,
    value: input.value,
    confidence: clampNumber(input.confidence, 0, 1),
    evidence: input.evidence,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  persona.facts.push(fact);
  return fact;
};

export const deduplicateFacts = (persona: Persona): void => {
  for (const fact of persona.facts) {
    if (!fact.status) fact.status = "active";
  }

  const factMap = new Map<string, Fact[]>();
  for (const fact of persona.facts) {
    if (fact.status !== "active") continue;
    const key = `${fact.key}:${JSON.stringify(fact.value)}`;
    if (!factMap.has(key)) factMap.set(key, []);
    factMap.get(key)?.push(fact);
  }

  for (const duplicates of factMap.values()) {
    if (duplicates.length <= 1) continue;
    duplicates.sort((a, b) => b.confidence - a.confidence);
    const bestFact = duplicates[0];
    const allEvidence: FactEvidence[] = [];
    for (const dup of duplicates) {
      for (const evidence of dup.evidence) {
        const exists = allEvidence.some(
          (e) =>
            e.conversationId === evidence.conversationId &&
            e.turnIds.length === evidence.turnIds.length &&
            e.turnIds.every((id, i) => id === evidence.turnIds[i]),
        );
        if (!exists) allEvidence.push(evidence);
      }
      if (dup !== bestFact) dup.status = "superseded";
    }
    bestFact.evidence = allEvidence;
  }

  const keyMap = new Map<string, Fact[]>();
  for (const fact of persona.facts) {
    if (fact.status !== "active") continue;
    if (!keyMap.has(fact.key)) keyMap.set(fact.key, []);
    keyMap.get(fact.key)?.push(fact);
  }

  for (const facts of keyMap.values()) {
    if (facts.length <= 1) continue;
    facts.sort((a, b) => b.confidence - a.confidence);
    const bestFact = facts[0];
    for (const fact of facts) {
      if (fact !== bestFact) fact.status = "superseded";
    }
  }

  persona.facts = persona.facts.filter((fact) => fact.status === "active");
};
