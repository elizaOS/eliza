/**
 * Pure resolver for under-specified owner asks.
 *
 * Runtime wiring gathers candidate referents from owner facts, recent threads,
 * calendar/todo state, and episodic anchors; this module ranks those candidates
 * and either returns the resolved interpretation or one disambiguating question.
 * Execution stays outside this module so destructive actions remain preview-first.
 */

export type ImplicitReferentSource =
  | "owner_fact"
  | "recent_thread"
  | "calendar_event"
  | "todo"
  | "episodic_anchor";

export interface ImplicitReferentCandidate {
  readonly id: string;
  readonly source: ImplicitReferentSource;
  readonly label: string;
  readonly summary: string;
  readonly confirmation: string;
  readonly tags?: readonly string[];
  readonly occurredAt?: string;
  readonly prior?: number;
  readonly executorHint?: string;
}

export interface RankedImplicitReferent {
  readonly candidate: ImplicitReferentCandidate;
  readonly score: number;
  readonly evidence: readonly string[];
}

export type ImplicitReferentResolution =
  | {
      readonly decision: "resolved";
      readonly selected: RankedImplicitReferent;
      readonly ranked: readonly RankedImplicitReferent[];
      readonly confirmationText: string;
      readonly question: null;
    }
  | {
      readonly decision: "ask";
      readonly selected: null;
      readonly ranked: readonly RankedImplicitReferent[];
      readonly confirmationText: null;
      readonly question: string;
    };

export interface ResolveImplicitReferentInput {
  readonly ask: string;
  readonly nowIso: string;
  readonly candidates: readonly ImplicitReferentCandidate[];
  readonly minConfidence?: number;
  readonly ambiguityMargin?: number;
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "book",
  "clear",
  "for",
  "from",
  "i",
  "it",
  "last",
  "like",
  "me",
  "my",
  "of",
  "on",
  "same",
  "the",
  "this",
  "time",
  "to",
  "usual",
  "why",
  "you",
  "know",
]);

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(value: string): string[] {
  return normalize(value)
    .split(" ")
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

function parseTime(value: string, label: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`[ImplicitReferents] invalid ${label}: ${value}`);
  }
  return ms;
}

function daysAgo(nowIso: string, occurredAt: string): number {
  return Math.max(
    0,
    (parseTime(nowIso, "nowIso") - parseTime(occurredAt, "occurredAt")) /
      86_400_000,
  );
}

function candidateText(candidate: ImplicitReferentCandidate): string {
  return normalize(
    [candidate.label, candidate.summary, ...(candidate.tags ?? [])].join(" "),
  );
}

function implicitSignals(ask: string): Set<string> {
  const normalized = normalize(ask);
  const signals = new Set<string>();
  if (normalized.includes("you know why")) signals.add("reason");
  if (normalized.includes("usual")) signals.add("usual");
  if (
    normalized.includes("same reason") ||
    normalized.includes("same as last time") ||
    normalized.includes("last time")
  ) {
    signals.add("episodic");
  }
  if (normalized.includes("last quarter")) signals.add("quarterly");
  if (
    /\b(mon|monday|tue|tuesday|wed|wednesday|thu|thursday|fri|friday|sat|saturday|sun|sunday)\b/.test(
      normalized,
    )
  ) {
    signals.add("weekday");
  }
  if (normalized.includes("afternoon")) signals.add("afternoon");
  return signals;
}

function sourceSignalBoost(
  source: ImplicitReferentSource,
  signals: ReadonlySet<string>,
): number {
  let score = 0;
  if (signals.has("usual") && source === "owner_fact") score += 0.32;
  if (signals.has("episodic") && source === "episodic_anchor") score += 0.34;
  if (signals.has("reason") && source === "recent_thread") score += 0.18;
  if (signals.has("quarterly") && source === "episodic_anchor") score += 0.16;
  if (signals.has("weekday") && source === "calendar_event") score += 0.08;
  return score;
}

function lexicalScore(
  askTokens: readonly string[],
  candidate: ImplicitReferentCandidate,
): { score: number; evidence: string[] } {
  if (askTokens.length === 0) return { score: 0, evidence: [] };
  const haystack = candidateText(candidate);
  const matched = askTokens.filter((token) => haystack.includes(token));
  return {
    score: matched.length / askTokens.length,
    evidence: matched.map((token) => `matched "${token}"`),
  };
}

function tagSignalEvidence(
  candidate: ImplicitReferentCandidate,
  signals: ReadonlySet<string>,
): string[] {
  const tags = new Set((candidate.tags ?? []).map(normalize));
  const evidence: string[] = [];
  for (const signal of signals) {
    if (tags.has(signal)) evidence.push(`candidate tagged "${signal}"`);
  }
  return evidence;
}

function rankCandidate(
  input: ResolveImplicitReferentInput,
  candidate: ImplicitReferentCandidate,
  signals: ReadonlySet<string>,
  askTokens: readonly string[],
): RankedImplicitReferent {
  const lexical = lexicalScore(askTokens, candidate);
  const evidence = [
    ...lexical.evidence,
    ...tagSignalEvidence(candidate, signals),
  ];
  let score = lexical.score * 0.44;
  score += sourceSignalBoost(candidate.source, signals);
  if (typeof candidate.prior === "number" && Number.isFinite(candidate.prior)) {
    score += Math.max(0, Math.min(candidate.prior, 1)) * 0.2;
    evidence.push(`prior=${candidate.prior.toFixed(2)}`);
  }
  if (candidate.occurredAt) {
    const ageDays = daysAgo(input.nowIso, candidate.occurredAt);
    const recency = Math.max(0, 1 - ageDays / 30);
    score += recency * 0.16;
    evidence.push(`recency=${recency.toFixed(2)}`);
  }
  return {
    candidate,
    score: Math.min(1, Number(score.toFixed(4))),
    evidence,
  };
}

function buildQuestion(ranked: readonly RankedImplicitReferent[]): string {
  const choices = ranked.slice(0, 2).map((entry) => entry.candidate.label);
  if (choices.length === 0) {
    return "Which context should I use for that?";
  }
  if (choices.length === 1) {
    return `Do you mean ${choices[0]}?`;
  }
  return `Do you mean ${choices[0]} or ${choices[1]}?`;
}

function buildConfirmation(
  ask: string,
  selected: RankedImplicitReferent,
): string {
  const evidence = selected.evidence.slice(0, 2).join("; ");
  return `Resolving "${ask}" as ${selected.candidate.confirmation}${evidence ? ` (${evidence})` : ""}.`;
}

export function resolveImplicitReferent(
  input: ResolveImplicitReferentInput,
): ImplicitReferentResolution {
  parseTime(input.nowIso, "nowIso");
  const minConfidence = input.minConfidence ?? 0.62;
  const ambiguityMargin = input.ambiguityMargin ?? 0.14;
  const signals = implicitSignals(input.ask);
  const askTokens = tokens(input.ask);
  const ranked = input.candidates
    .map((candidate) => rankCandidate(input, candidate, signals, askTokens))
    .sort(
      (a, b) =>
        b.score - a.score || a.candidate.id.localeCompare(b.candidate.id),
    );

  const top = ranked[0];
  if (!top || top.score < minConfidence) {
    return {
      decision: "ask",
      selected: null,
      ranked,
      confirmationText: null,
      question: buildQuestion(ranked),
    };
  }
  const second = ranked[1];
  if (second && top.score - second.score < ambiguityMargin) {
    return {
      decision: "ask",
      selected: null,
      ranked,
      confirmationText: null,
      question: buildQuestion(ranked),
    };
  }
  return {
    decision: "resolved",
    selected: top,
    ranked,
    confirmationText: buildConfirmation(input.ask, top),
    question: null,
  };
}
