/**
 * Identity-observation pipeline routing through EntityStore + RelationshipStore.
 *
 * Takes platform-side observations (gmail-sender, phone-contact, chat-identity,
 * etc.), normalizes them via `normalizeIdentityObservation` helpers, and routes
 * the result through:
 *   1. `EntityStore.observeIdentity` — collapses identities by (platform, handle)
 *   2. `RelationshipStore.observe`   — strengthens edges that already exist
 */

import type { EntityStore } from "../entities/store.js";
import type { Entity } from "../entities/types.js";
import { SELF_ENTITY_ID } from "../entities/types.js";
import type {
  LifeOpsIdentityObservation,
  NormalizedLifeOpsIdentityObservation,
} from "../identity-observations.js";
import {
  normalizeIdentityObservation,
  planIdentityObservationIngestion,
} from "../identity-observations.js";
import type { RelationshipStore } from "../relationships/store.js";

export interface IdentityObserverOptions {
  entityStore: EntityStore;
  relationshipStore: RelationshipStore;
  /**
   * When true (default), edge-strengthening observations also call
   * RelationshipStore.observe to update the per-edge state. Set to false
   * for batch backfills where edge updates would be redundant.
   */
  strengthenEdges?: boolean;
}

export interface IdentityObserveOutcome {
  observation: NormalizedLifeOpsIdentityObservation;
  entity: Entity;
  mergedFrom?: string[];
  conflict?: boolean;
}

/**
 * Ingest a batch of platform observations. Returns one outcome per
 * observation. Errors from individual observations propagate — callers
 * that want best-effort batch processing should wrap with their own
 * iteration.
 */
export async function ingestIdentityObservationsThroughGraph(args: {
  options: IdentityObserverOptions;
  observations: LifeOpsIdentityObservation[];
}): Promise<IdentityObserveOutcome[]> {
  const plan = planIdentityObservationIngestion(args.observations);
  const outcomes: IdentityObserveOutcome[] = [];

  for (const observation of plan.normalizedObservations) {
    const outcome = await applyOneObservation({
      ...args.options,
      observation,
    });
    outcomes.push(outcome);
  }

  return outcomes;
}

/**
 * Apply a single identity observation. Public so tests / repo callers can
 * exercise just the entity side without the full plan pipeline.
 */
export async function applyOneObservation(args: {
  entityStore: EntityStore;
  relationshipStore: RelationshipStore;
  strengthenEdges?: boolean;
  observation: NormalizedLifeOpsIdentityObservation;
}): Promise<IdentityObserveOutcome> {
  const obs = args.observation;
  const handle = obs.identifiers.handles[0];

  // We rely on a strong identifier in the observation to anchor the
  // entity. If there are no identifiers, fall back to the highest-
  // confidence name as the platform-side handle so we still get a node.
  let platform: string;
  let handleStr: string;
  if (handle) {
    platform = handle.platform;
    handleStr = handle.handle;
  } else if (obs.identifiers.emails[0]) {
    platform = "email";
    handleStr = obs.identifiers.emails[0];
  } else if (obs.identifiers.phones[0]) {
    platform = "phone";
    handleStr = obs.identifiers.phones[0];
  } else {
    const name = obs.names[0]?.name;
    if (!name) {
      throw new Error("[observer] observation has no name or identifier");
    }
    platform = "name";
    handleStr = name;
  }

  const displayName = obs.names[0]?.name;
  const result = await args.entityStore.observeIdentity({
    platform,
    handle: handleStr,
    ...(displayName ? { displayName } : {}),
    evidence: [obs.id],
    confidence: obs.confidence,
    suggestedType: "person",
  });

  if (args.strengthenEdges !== false) {
    // Strengthen the self → entity "knows" edge. Higher-fidelity types
    // (colleague_of, manages, ...) come from extraction, not from raw
    // platform observations.
    if (result.entity.entityId !== SELF_ENTITY_ID) {
      await args.relationshipStore.observe({
        fromEntityId: SELF_ENTITY_ID,
        toEntityId: result.entity.entityId,
        type: "knows",
        evidence: [obs.id],
        confidence: obs.confidence,
        source: "platform_observation",
        occurredAt: obs.provenance.observedAt,
      });
    }
  }

  return {
    observation: obs,
    entity: result.entity,
    ...(result.mergedFrom ? { mergedFrom: result.mergedFrom } : {}),
    ...(result.conflict ? { conflict: true } : {}),
  };
}

export { normalizeIdentityObservation };
