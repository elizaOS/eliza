/**
 * Identity-merge engine for the EntityStore.
 *
 * Pure functions: given a set of Entity records and a new identity
 * observation, decide which existing entities (if any) are the same and
 * how to fold the new identity in. Preserves provenance — every collapsed
 * identity keeps its evidence trail, no observation is silently discarded.
 *
 * The store calls into this from both `observeIdentity` (auto-merge on
 * (platform, handle) match) and explicit `merge(target, sources)`.
 */

import type { Entity, EntityIdentity } from "./types.js";

/**
 * Threshold at which `observeIdentity` will auto-merge a new observation
 * into an existing entity without surfacing an approval task. Below this,
 * the observation is recorded but the merge becomes a proposal that the
 * scheduled-task layer surfaces for user confirmation.
 */
export const AUTO_MERGE_CONFIDENCE_THRESHOLD = 0.85;

/** Confidence at which a new identity claim outright overrides an existing
 * lower-confidence claim with the same (platform, handle). */
export const OVERRIDE_CONFIDENCE_DELTA = 0.15;

export interface IdentityMatchInput {
  platform: string;
  handle: string;
  confidence: number;
  /** Operator-confirmed (true) overrides auto-observed (false) on ties. */
  verified?: boolean;
}

/**
 * Find the entities whose identities collide on `(platform, handle)`.
 * Multiple matches indicate a conflict (the same handle is claimed by
 * different entities) — the caller surfaces this for approval.
 */
export function findIdentityMatches(
  entities: Entity[],
  match: IdentityMatchInput,
): Entity[] {
  const platformKey = match.platform.toLowerCase();
  const handleKey = match.handle.toLowerCase();
  return entities.filter((entity) =>
    entity.identities.some(
      (identity) =>
        identity.platform.toLowerCase() === platformKey &&
        identity.handle.toLowerCase() === handleKey,
    ),
  );
}

/**
 * Decide the outcome of an `observeIdentity` call:
 *  - "create": no match; create a new entity with this identity.
 *  - "merge": exactly one match; fold the new identity in.
 *  - "conflict": multiple matches OR the match is below the auto-merge
 *    threshold; surface for user approval.
 */
export type IdentityObserveOutcome =
  | { kind: "create" }
  | { kind: "merge"; targetEntityId: string }
  | { kind: "conflict"; candidateEntityIds: string[]; reason: string };

export function decideIdentityOutcome(args: {
  candidates: Entity[];
  newConfidence: number;
}): IdentityObserveOutcome {
  if (args.candidates.length === 0) {
    return { kind: "create" };
  }

  if (args.candidates.length === 1) {
    const target = args.candidates[0];
    if (!target) {
      return { kind: "create" };
    }
    if (args.newConfidence >= AUTO_MERGE_CONFIDENCE_THRESHOLD) {
      return { kind: "merge", targetEntityId: target.entityId };
    }
    // Below threshold — store the observation but flag for approval.
    return {
      kind: "conflict",
      candidateEntityIds: [target.entityId],
      reason: "low_confidence_observation",
    };
  }

  return {
    kind: "conflict",
    candidateEntityIds: args.candidates.map((entity) => entity.entityId),
    reason: "multiple_candidate_entities",
  };
}

/**
 * Fold a new identity into an existing entity's identities array. If the
 * (platform, handle) already exists, evidence is concatenated (deduped) and
 * the higher-confidence claim wins. Otherwise, the new identity is
 * appended.
 */
export function foldIdentity(
  existing: EntityIdentity[],
  next: EntityIdentity,
): EntityIdentity[] {
  const platformKey = next.platform.toLowerCase();
  const handleKey = next.handle.toLowerCase();
  const matchIndex = existing.findIndex(
    (identity) =>
      identity.platform.toLowerCase() === platformKey &&
      identity.handle.toLowerCase() === handleKey,
  );

  if (matchIndex < 0) {
    return [...existing, next];
  }

  const match = existing[matchIndex];
  if (!match) {
    return [...existing, next];
  }
  const mergedEvidence = Array.from(
    new Set([...match.evidence, ...next.evidence]),
  );
  // Conflict resolution per W1-E spec:
  //   - highest-confidence claim wins
  //   - on confidence ties, verified: true wins over verified: false
  //   - if still ambiguous, keep the existing (older) claim's metadata
  //     and merely strengthen evidence + bump confidence to the higher of
  //     the two; the merger surfaces the ambiguity through the conflict
  //     path before reaching this point.
  let chosen = match;
  if (next.confidence > match.confidence) {
    chosen = next;
  } else if (
    next.confidence === match.confidence &&
    next.verified &&
    !match.verified
  ) {
    chosen = next;
  }

  const merged: EntityIdentity = {
    ...chosen,
    confidence: Math.max(match.confidence, next.confidence),
    verified: match.verified || next.verified,
    evidence: mergedEvidence,
    addedAt: match.addedAt,
    addedVia: chosen.addedVia,
    ...(chosen.displayName ? { displayName: chosen.displayName } : {}),
  };

  const result = [...existing];
  result[matchIndex] = merged;
  return result;
}

/**
 * Explicit merge: take a target entity and fold N source entities into it,
 * preserving every identity, attribute, and tag. Returns the merged entity
 * (caller persists it and removes the sources). Provenance is preserved
 * verbatim — no identity is dropped, only deduplicated by (platform, handle).
 */
export function mergeEntities(args: {
  target: Entity;
  sources: Entity[];
  now: string;
}): Entity {
  let identities = [...args.target.identities];
  const tags = new Set(args.target.tags);
  const attributes = { ...(args.target.attributes ?? {}) };
  const seenLastObserved: string[] = [args.target.state.lastObservedAt ?? ""];
  const seenLastInbound: string[] = [args.target.state.lastInboundAt ?? ""];
  const seenLastOutbound: string[] = [args.target.state.lastOutboundAt ?? ""];

  for (const source of args.sources) {
    for (const identity of source.identities) {
      identities = foldIdentity(identities, identity);
    }
    for (const tag of source.tags) {
      tags.add(tag);
    }
    for (const [key, attr] of Object.entries(source.attributes ?? {})) {
      const existing = attributes[key];
      if (!existing || attr.confidence > existing.confidence) {
        attributes[key] = attr;
      } else if (attr.confidence === existing.confidence) {
        attributes[key] = {
          ...existing,
          evidence: Array.from(
            new Set([...existing.evidence, ...attr.evidence]),
          ),
        };
      }
    }
    if (source.state.lastObservedAt) {
      seenLastObserved.push(source.state.lastObservedAt);
    }
    if (source.state.lastInboundAt) {
      seenLastInbound.push(source.state.lastInboundAt);
    }
    if (source.state.lastOutboundAt) {
      seenLastOutbound.push(source.state.lastOutboundAt);
    }
  }

  const pickLatest = (values: string[]): string | undefined => {
    const filtered = values.filter((v) => v.length > 0);
    if (filtered.length === 0) return undefined;
    return filtered.reduce((acc, cur) => (cur > acc ? cur : acc));
  };

  return {
    ...args.target,
    identities,
    tags: Array.from(tags).sort(),
    attributes:
      Object.keys(attributes).length > 0 ? attributes : args.target.attributes,
    state: {
      ...args.target.state,
      ...(pickLatest(seenLastObserved)
        ? { lastObservedAt: pickLatest(seenLastObserved) }
        : {}),
      ...(pickLatest(seenLastInbound)
        ? { lastInboundAt: pickLatest(seenLastInbound) }
        : {}),
      ...(pickLatest(seenLastOutbound)
        ? { lastOutboundAt: pickLatest(seenLastOutbound) }
        : {}),
    },
    updatedAt: args.now,
  };
}
