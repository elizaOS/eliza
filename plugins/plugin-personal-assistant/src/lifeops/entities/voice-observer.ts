/**
 * High-level voice-attribution observer that wires a voice turn into
 * the LifeOps entity + relationship graph.
 *
 * Implements the R2-speaker.md §7.3 "Jill scenario" semantics:
 *   - Match-or-create an Entity from the imprint cluster.
 *   - On a self-name claim ("I'm Jill" / "hey there, I'm Jill"), use
 *     that name as the entity's preferredName via observeIdentity.
 *   - On an owner-relationship claim ("Jill is my wife"), queue a
 *     pending `partner_of` row that resolves the first time Jill is
 *     observed via voice and her name is known.
 *
 * The observer is intentionally stateful — the pending-relationship
 * queue lives on the instance. The engine constructs one observer per
 * runtime; tests construct one per scenario.
 */

import type { RelationshipStore } from "../relationships/store.js";
import type { EntityStore } from "./store.js";
import { SELF_ENTITY_ID } from "./types.js";
import {
  type BindVoiceTurnResult,
  bindVoiceTurnToEntity,
  extractKinClaim,
  extractSelfAffiliationClaim,
  PendingRelationshipQueue,
} from "./voice-attribution.js";

export interface VoiceObserverDeps {
  entityStore: EntityStore;
  relationshipStore: RelationshipStore;
}

/** One ingested voice turn. */
export interface VoiceTurnObservation {
  /** Stable utterance id (transcriber turn id is fine). */
  turnId: string;
  /** Recognized text. */
  text: string;
  /** Imprint cluster id from the voice profile store. */
  imprintClusterId: string;
  /** Confidence of the imprint match (0..1). */
  matchConfidence: number;
  /** Matched entity if the imprint had a binding, else null. */
  matchedEntityId: string | null;
  /** When the turn was observed. */
  observedAt?: string;
  /** True if this turn was spoken by the OWNER. */
  isOwner?: boolean;
}

export interface VoiceTurnIngestResult {
  binding: BindVoiceTurnResult;
  /** Relationship rows produced for this turn (resolved or new). */
  relationshipIds: string[];
  /** Kin claims (partner/sibling) queued for later resolution (typically when isOwner=true). */
  queuedPartnerClaims: number;
  /**
   * Organization entity the speaker was bound to via `works_at` on this
   * turn ("I'm John from the accounting team"), when the utterance carried a
   * self-affiliation claim. Null otherwise.
   */
  affiliationOrgEntityId: string | null;
}

/**
 * `VoiceObserver` — single instance per runtime. Holds the pending
 * relationships queue across utterances.
 */
export class VoiceObserver {
  private readonly pendingQueue = new PendingRelationshipQueue();

  constructor(private readonly deps: VoiceObserverDeps) {}

  get pendingRelationshipsCount(): number {
    return this.pendingQueue.size();
  }

  /**
   * Ingest one voice turn. Side effects:
   *   - `EntityStore.observeIdentity({ platform:"voice", ... })` may
   *     create or merge an entity row.
   *   - When the speaker is the OWNER and the utterance contains an
   *     ownership-relationship claim ("X is my wife"), the queue is
   *     bumped — the row lands later, when X first speaks.
   *   - When the speaker is *not* the OWNER and their self-name claim
   *     matches a previously-queued partner claim, the pending
   *     relationship is realized via `RelationshipStore.observe`.
   */
  async ingestTurn(turn: VoiceTurnObservation): Promise<VoiceTurnIngestResult> {
    // Step 1: bind the imprint to an entity (create or match).
    const binding = await bindVoiceTurnToEntity({
      entityStore: this.deps.entityStore,
      pendingQueue: this.pendingQueue,
      matchedEntityId: turn.matchedEntityId,
      utteranceText: turn.text,
      imprintClusterId: turn.imprintClusterId,
      evidenceIds: [turn.turnId],
      matchConfidence: turn.matchConfidence,
    });

    // Step 2: realize any pending relationships the binding resolved.
    const relationshipIds: string[] = [];
    for (const pending of binding.pendingRelationships) {
      const rel = await this.deps.relationshipStore.observe({
        fromEntityId: pending.fromEntityId,
        toEntityId: binding.entityId,
        type: pending.type,
        metadataPatch: { label: pending.label },
        evidence: [pending.evidenceId, turn.turnId],
        confidence: 0.7,
        source: "extraction",
        occurredAt: turn.observedAt,
      });
      relationshipIds.push(rel.relationshipId);
    }

    // Step 3: if the OWNER speaks a kin claim (partner OR sibling — issue
    // #10726 added siblings), queue it for later resolution. We don't
    // resolve it on the owner's turn because we don't yet know which entity
    // the named person is.
    let queuedPartnerClaims = 0;
    if (turn.isOwner) {
      const claim = extractKinClaim(turn.text);
      if (claim) {
        // Try eager resolution — the owner might be referring to a
        // person we've already heard speak (named via self-claim).
        const candidates = await this.deps.entityStore.resolve({
          name: claim.name,
          type: "person",
        });
        const exact = candidates.find(
          (c) =>
            c.entity.preferredName.toLowerCase() === claim.name.toLowerCase() &&
            c.entity.entityId !== SELF_ENTITY_ID,
        );
        if (exact) {
          const rel = await this.deps.relationshipStore.observe({
            fromEntityId: SELF_ENTITY_ID,
            toEntityId: exact.entity.entityId,
            type: claim.type,
            metadataPatch: { label: claim.label },
            evidence: [turn.turnId],
            confidence: 0.7,
            source: "extraction",
            occurredAt: turn.observedAt,
          });
          relationshipIds.push(rel.relationshipId);
        } else {
          this.pendingQueue.enqueue({
            type: claim.type,
            fromEntityId: SELF_ENTITY_ID,
            toName: claim.name,
            label: claim.label,
            evidenceId: turn.turnId,
            createdAt: turn.observedAt ?? new Date().toISOString(),
          });
          queuedPartnerClaims += 1;
        }
      }
    }

    // Step 4: a self-affiliation claim ("I'm John from the accounting team",
    // "I work at Acme") binds the SPEAKING entity to an organization entity
    // via `works_at` on the same turn (issue #10726 — the voice path
    // previously dropped affiliations; `works_at` existed only in the text
    // pipeline). The organization is match-or-created through the same merge
    // engine with a deterministic voice-org handle so repeated mentions of
    // the same org fold into one entity.
    let affiliationOrgEntityId: string | null = null;
    const affiliation = extractSelfAffiliationClaim(turn.text);
    if (affiliation) {
      const orgResult = await this.deps.entityStore.observeIdentity({
        platform: "voice",
        handle: `org:${affiliation.organization.toLowerCase()}`,
        displayName: affiliation.organization,
        evidence: [turn.turnId],
        confidence: 0.6,
        suggestedType: "organization",
      });
      affiliationOrgEntityId = orgResult.entity.entityId;
      const rel = await this.deps.relationshipStore.observe({
        fromEntityId: binding.entityId,
        toEntityId: orgResult.entity.entityId,
        type: "works_at",
        metadataPatch: { organization: affiliation.organization },
        evidence: [turn.turnId],
        confidence: 0.6,
        source: "extraction",
        occurredAt: turn.observedAt,
      });
      relationshipIds.push(rel.relationshipId);
    }

    return {
      binding,
      relationshipIds,
      queuedPartnerClaims,
      affiliationOrgEntityId,
    };
  }

  /** Test utility: peek at the pending queue. */
  peekPending(): ReturnType<PendingRelationshipQueue["all"]> {
    return this.pendingQueue.all();
  }
}
