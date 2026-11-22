/** Source-bound history retention. A review classifies complete originals;
 * foreground callers keep all originals when the saved prefix no longer matches.
 * Persistence belongs to the existing incremental evaluator journal. */

import type { ContextObject } from "@elizaos/core";
import {
  collectCompletionContextSources,
  ElizaError,
  hashStableJson,
} from "@elizaos/core";

/** Complete recent sources always supplied to the foreground. */
export const HISTORY_CONTINUITY_SOURCE_COUNT = 10;

export type HistoryRetentionScope = {
  agentId: string;
  roomId: string;
  entityId: string;
  roles: string[];
};
type Source = ReturnType<typeof collectCompletionContextSources>[number];
export type HistoryRetentionCheckpoint = {
  version: 1;
  scopeHash: string;
  reviewedCount: number;
  prefixHash: string;
  retainedEventIds: string[];
  /** Original-source relationships survive deferral and are bound by prefixHash. */
  dependencyEventGroups?: string[][];
};
export type HistoryRetentionReview = {
  sourceSetId: string;
  complete: boolean;
  retainSourceIds: string[];
  deferSourceIds: string[];
  uncertainSourceIds: string[];
  dependencyGroups: string[][];
};
export type HistoryRetentionPrepared = {
  scope: HistoryRetentionScope;
  previous: HistoryRetentionCheckpoint | null;
  expectedStoredHash: string;
  evidenceId: string;
  prefix: Source[];
  candidates: Source[];
  linkedSourceGroups: string[][];
  sourceSetId: string;
};

const hash = /^[0-9a-f]{64}$/;
function requireValue(value: unknown, message: string): asserts value {
  if (!value)
    throw new ElizaError(message, {
      code: "HISTORY_RETENTION_INVALID_REVIEW",
      severity: "ephemeral",
    });
}
function scopeHash(scope: HistoryRetentionScope): string {
  requireValue(
    scope &&
      ["agentId", "roomId", "entityId"].every(
        (k) =>
          typeof scope[k as keyof HistoryRetentionScope] === "string" &&
          scope[k as keyof HistoryRetentionScope].length > 0,
      ),
    "Invalid scope",
  );
  requireValue(
    Array.isArray(scope.roles) &&
      scope.roles.every((r) => typeof r === "string") &&
      new Set(scope.roles).size === scope.roles.length,
    "Invalid roles",
  );
  return hashStableJson({ ...scope, roles: [...scope.roles].sort() });
}
function sourcePrefixHash(
  scope: HistoryRetentionScope,
  sources: Source[],
): string {
  // Turn IDs change on every request; only original source identities/bytes and
  // the audience scope bind this reusable prefix. hN positions remain bound.
  return hashStableJson({ scopeHash: scopeHash(scope), sources });
}
function stringIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((v) => typeof v === "string" && v.length > 0) &&
    new Set(value).size === value.length
  );
}
export function validateHistoryRetention(
  context: ContextObject,
  scope: HistoryRetentionScope,
  raw: unknown,
): HistoryRetentionCheckpoint | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const cp = raw as HistoryRetentionCheckpoint;
  if (
    Object.keys(cp)
      .filter((key) => key !== "dependencyEventGroups")
      .sort()
      .join(",") !==
    "prefixHash,retainedEventIds,reviewedCount,scopeHash,version"
  )
    return null;
  if (
    cp.version !== 1 ||
    cp.scopeHash !== scopeHash(scope) ||
    !Number.isSafeInteger(cp.reviewedCount) ||
    cp.reviewedCount < 0 ||
    !hash.test(cp.prefixHash) ||
    !stringIds(cp.retainedEventIds)
  )
    return null;
  if (context.metadata?.roomId !== scope.roomId) return null;
  const sources = collectCompletionContextSources(context);
  // The selector deliberately returns no IDs for duplicate/ambiguous dialogue.
  // An empty saved prefix must not turn that failure into an empty projection.
  if (
    sources.length === 0 &&
    context.events.some((event) => event.source === "prior-dialogue")
  )
    return null;
  if (sources.length < cp.reviewedCount) return null;
  const prefix = sources.slice(0, cp.reviewedCount);
  if (sourcePrefixHash(scope, prefix) !== cp.prefixHash) return null;
  const ids = new Set(prefix.map((s) => s.event.id));
  if (cp.retainedEventIds.some((id) => !ids.has(id))) return null;
  if (
    cp.dependencyEventGroups !== undefined &&
    (!Array.isArray(cp.dependencyEventGroups) ||
      cp.dependencyEventGroups.some(
        (group) =>
          !stringIds(group) ||
          group.length < 2 ||
          group.some((id) => !ids.has(id)),
      ))
  )
    return null;
  return structuredClone(cp);
}

/** Shared source relationships form connected groups, independent of retention. */
export function linkedSourceNeighbors(
  groups: readonly string[][],
): Map<string, Set<string>> {
  const neighbors = new Map<string, Set<string>>();
  for (const group of groups) {
    const first = group[0];
    for (const id of group.slice(1)) {
      if (!neighbors.has(first)) neighbors.set(first, new Set());
      if (!neighbors.has(id)) neighbors.set(id, new Set());
      neighbors.get(first)?.add(id);
      neighbors.get(id)?.add(first);
    }
  }
  return neighbors;
}

/** Preserve complete connected originals without inferring links from prose. */
export function includeLinkedSources(
  retained: Set<string>,
  groups: readonly string[][],
): void {
  const neighbors = linkedSourceNeighbors(groups);
  const pending = [...retained];
  while (pending.length) {
    const id = pending.pop();
    if (id === undefined) break;
    for (const linked of neighbors.get(id) ?? []) {
      if (retained.has(linked)) continue;
      retained.add(linked);
      pending.push(linked);
    }
  }
}

/** The caller supplies the end of its complete ordered evidence page; this is
 * not a source cap. Every later original stays inline and pending for review. */
export function prepareHistoryRetention(
  context: ContextObject,
  scope: HistoryRetentionScope,
  stored: unknown,
  evidenceId: string,
  reviewEnd: number,
  linkedEventGroups: readonly string[][] = [],
): HistoryRetentionPrepared {
  requireValue(
    context.metadata?.roomId === scope.roomId && evidenceId.length > 0,
    "Wrong room or missing evidence",
  );
  const sources = collectCompletionContextSources(context);
  requireValue(
    Number.isSafeInteger(reviewEnd) &&
      reviewEnd >= 0 &&
      reviewEnd <= sources.length,
    "Invalid complete evidence boundary",
  );
  const previous = validateHistoryRetention(context, scope, stored);
  requireValue(
    !previous || reviewEnd >= previous.reviewedCount,
    "Evidence cannot move backward",
  );
  const prefix = structuredClone(sources.slice(0, reviewEnd));
  const retained = new Set(previous?.retainedEventIds ?? []);
  const byEvent = new Map(prefix.map((source) => [source.event.id, source.id]));
  requireValue(
    linkedEventGroups.every((group) => stringIds(group) && group.length > 1),
    "Invalid linked originals",
  );
  const allLinkedSourceGroups = [
    ...linkedEventGroups,
    ...(previous?.dependencyEventGroups ?? []),
  ]
    .filter((group) => group.every((id) => byEvent.has(id)))
    .map((group) => group.map((id) => byEvent.get(id) as string));
  const candidateIds = new Set(
    prefix
      .filter(
        (source, i) =>
          !previous ||
          i >= previous.reviewedCount ||
          retained.has(source.event.id),
      )
      .map((source) => source.id),
  );
  // A linked reply may have been deferred by an older reviewer. Supply its
  // complete original again before asking for a new classification.
  includeLinkedSources(candidateIds, allLinkedSourceGroups);
  const linkedSourceGroups = allLinkedSourceGroups.filter((group) =>
    group.some((id) => candidateIds.has(id)),
  );
  const candidates = prefix.filter((source) => candidateIds.has(source.id));
  const expectedStoredHash = hashStableJson(stored ?? null);
  const sourceSetId = hashStableJson({
    scopeHash: scopeHash(scope),
    evidenceId,
    expectedStoredHash,
    prefixHash: sourcePrefixHash(scope, prefix),
    candidates,
    linkedSourceGroups,
  });
  return {
    scope: structuredClone(scope),
    previous,
    expectedStoredHash,
    evidenceId,
    prefix,
    candidates,
    linkedSourceGroups,
    sourceSetId,
  };
}

/** Model classification must account for every supplied candidate exactly once.
 * This validates accounting and binding, not the model's semantic judgment. */
export function applyHistoryRetentionReview(
  prepared: HistoryRetentionPrepared,
  output: HistoryRetentionReview,
): HistoryRetentionCheckpoint {
  requireValue(
    output &&
      output.complete === true &&
      output.sourceSetId === prepared.sourceSetId,
    "Incomplete or stale review",
  );
  const arrays = [
    output.retainSourceIds,
    output.deferSourceIds,
    output.uncertainSourceIds,
  ];
  requireValue(arrays.every(stringIds), "Invalid classification arrays");
  const supplied = new Map(prepared.candidates.map((s) => [s.id, s]));
  const classified = arrays.flat();
  const classifiedSet = new Set(classified);
  requireValue(
    classifiedSet.size === classified.length &&
      classified.every((id) => supplied.has(id)),
    "Duplicate or unknown source classification",
  );
  // Omission is uncertainty, never permission to hide an original. Keep it
  // visible and supply it again in the next review, including linked sources.
  const omitted = [...supplied.keys()].filter((id) => !classifiedSet.has(id));
  const retained = new Set([
    ...output.retainSourceIds,
    ...output.uncertainSourceIds,
    ...omitted,
  ]);
  requireValue(
    Array.isArray(output.dependencyGroups) &&
      output.dependencyGroups.every(
        (g) =>
          stringIds(g) && g.length > 0 && g.every((id) => supplied.has(id)),
      ),
    "Invalid dependency group",
  );
  // A declared dependency takes precedence over a conflicting deferral. Keep
  // the whole group visible; never resolve the contradiction by dropping it.
  for (const group of output.dependencyGroups)
    for (const id of group) retained.add(id);
  includeLinkedSources(retained, prepared.linkedSourceGroups);
  const dependencyEventGroups = [
    ...new Map(
      [
        ...(prepared.previous?.dependencyEventGroups ?? []),
        ...output.dependencyGroups
          .filter((group) => group.length > 1)
          .map((group) =>
            group.map((id) => {
              const source = supplied.get(id);
              requireValue(source, "Unknown dependency source");
              return source.event.id;
            }),
          ),
      ].map((group) => {
        const ordered = [...group].sort();
        return [JSON.stringify(ordered), ordered] as const;
      }),
    ).values(),
  ];
  const cp: HistoryRetentionCheckpoint = {
    version: 1,
    ...(dependencyEventGroups.length ? { dependencyEventGroups } : {}),
    scopeHash: scopeHash(prepared.scope),
    reviewedCount: prepared.prefix.length,
    prefixHash: sourcePrefixHash(prepared.scope, prepared.prefix),
    retainedEventIds: prepared.prefix
      .filter((s) => retained.has(s.id))
      .map((s) => s.event.id),
  };
  return cp;
}

/** Most originals a host without a reviewer keeps inline before it defers a batch. */
export const HISTORY_WINDOW_MAX_SOURCES = 40;
/** Originals left inline directly after a batch is deferred. */
export const HISTORY_WINDOW_KEEP_SOURCES = 20;
/** Deferred user messages kept inline because their wording reads as standing. */
export const HISTORY_WINDOW_STANDING_SOURCES = 12;

/**
 * Wording that usually states a standing instruction or a lasting fact about
 * the speaker. No reviewer reads what a positional boundary defers, so this is
 * the only thing that keeps "always read it back before sending" in view once
 * it is older than the window. English only, and a floor rather than a
 * judgement: a miss is still readable through the history references.
 */
const STANDING_WORDING =
  /\b(?:always|never|from now on|going forward|in (?:the )?future|every time|each time|whenever|remember (?:that|to|my)|don['’]?t (?:ever|forget)|do not (?:ever|forget)|i prefer|call me|my name is|i(?:['’]m| am) allergic|unless i)\b/i;

/**
 * Boundary for a host whose background reviewer never runs. Without a
 * checkpoint the foreground renders the room's whole lifetime on every model
 * call of every turn. This defers the originals before a boundary without
 * reviewing them; every deferred original stays readable through the history
 * references. The boundary depends only on the sources at or before it and
 * advances a batch at a time, so between two advances the inline transcript
 * only grows at its end and a provider can reuse the prompt prefix. It starts
 * on a user message, so a reply is never shown without its request.
 * `windowed` is true when the boundary lies past everything a reviewer saw.
 */
export function windowHistoryRetention(
  context: ContextObject,
  scope: HistoryRetentionScope,
  stored: unknown,
): { checkpoint: HistoryRetentionCheckpoint | null; windowed: boolean } {
  const previous = validateHistoryRetention(context, scope, stored);
  const reviewed = { checkpoint: previous, windowed: false };
  if (context.metadata?.roomId !== scope.roomId) return reviewed;
  const sources = collectCompletionContextSources(context);
  const reviewedCount = previous?.reviewedCount ?? 0;
  if (sources.length - reviewedCount <= HISTORY_WINDOW_MAX_SOURCES)
    return reviewed;
  const step = HISTORY_WINDOW_MAX_SOURCES - HISTORY_WINDOW_KEEP_SOURCES;
  let boundary =
    Math.floor((sources.length - HISTORY_WINDOW_KEEP_SOURCES) / step) * step;
  while (
    boundary < sources.length &&
    sources[boundary].event.segment.label !== "prior_message:user"
  )
    boundary++;
  if (boundary <= reviewedCount) return reviewed;
  const prefix = sources.slice(0, boundary);
  const retained = new Set(previous?.retainedEventIds ?? []);
  const standing = prefix
    .filter(
      (source, index) =>
        index >= reviewedCount &&
        source.event.segment.label === "prior_message:user" &&
        STANDING_WORDING.test(source.event.segment.content),
    )
    .slice(-HISTORY_WINDOW_STANDING_SOURCES);
  for (const source of standing) retained.add(source.event.id);
  return {
    windowed: true,
    checkpoint: {
      version: 1,
      ...(previous?.dependencyEventGroups
        ? { dependencyEventGroups: previous.dependencyEventGroups }
        : {}),
      scopeHash: scopeHash(scope),
      reviewedCount: boundary,
      prefixHash: sourcePrefixHash(scope, prefix),
      retainedEventIds: prefix
        .filter((source) => retained.has(source.event.id))
        .map((source) => source.event.id),
    },
  };
}

export function visibleHistoryEventIds(
  context: ContextObject,
  scope: HistoryRetentionScope,
  stored: unknown,
): Set<string> | null {
  const cp = validateHistoryRetention(context, scope, stored);
  if (!cp) return null; // full original rendering
  const sources = collectCompletionContextSources(context);
  const result = new Set(cp.retainedEventIds);
  let start = sources.length - 1;
  while (
    start > 0 &&
    sources[start].event.segment.label === "prior_message:agent"
  )
    start--;
  while (
    start > 0 &&
    sources[start - 1].event.segment.label === "prior_message:user"
  )
    start--;
  // An exchange that is one long run of user messages (a group the agent stays
  // silent in) must not bring the whole room back inline.
  start = Math.max(start, sources.length - HISTORY_WINDOW_MAX_SOURCES);
  // Keep conversational continuity even when the background reviewer has
  // deferred ordinary recent exchanges. This is a floor, never a cap on
  // retained constraints or unreviewed originals.
  start = Math.min(
    start,
    Math.max(0, sources.length - HISTORY_CONTINUITY_SOURCE_COUNT),
  );
  for (const [i, source] of sources.entries())
    if (i >= cp.reviewedCount || i >= start) result.add(source.event.id);
  includeLinkedSources(result, cp.dependencyEventGroups ?? []);
  return result;
}
