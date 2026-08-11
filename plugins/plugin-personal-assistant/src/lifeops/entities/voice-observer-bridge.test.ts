/**
 * Tests for the VOICE_TURN_OBSERVED → VoiceObserver bridge.
 *
 * Proves the previously-dead `VoiceObserver` is now driven at runtime: a
 * voice turn folds into the entity graph via the merge engine, and the
 * resulting binding is round-tripped via VOICE_ENTITY_BOUND so the
 * voice-profile owner (plugin-local-inference) can persist it.
 *
 * Uses in-memory store fakes (the real EntityStore/RelationshipStore need
 * Postgres) injected through the bridge's `setVoiceObserverFactory` seam.
 */

import { EventType, type IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Relationship,
  RelationshipSource,
} from "../relationships/types.js";
import type {
  Entity,
  EntityIdentity,
  EntityResolveCandidate,
} from "./types.js";
import { VoiceObserver } from "./voice-observer.js";
import {
  handleVoiceTurnObserved,
  setVoiceObserverFactory,
} from "./voice-observer-bridge.js";

const nowIso = () => "2026-06-04T10:00:00.000Z";
let entityCounter = 0;

class FakeEntityStore {
  private entities = new Map<string, Entity>();

  async get(entityId: string): Promise<Entity | null> {
    return this.entities.get(entityId) ?? null;
  }

  async list(): Promise<Entity[]> {
    return Array.from(this.entities.values());
  }

  async observeIdentity(obs: {
    platform: string;
    handle: string;
    displayName?: string;
    evidence: string[];
    confidence: number;
    suggestedType?: string;
  }): Promise<{ entity: Entity; mergedFrom?: string[] }> {
    for (const entity of this.entities.values()) {
      const match = entity.identities.find(
        (id) => id.platform === obs.platform && id.handle === obs.handle,
      );
      if (match) return { entity, mergedFrom: [entity.entityId] };
    }
    entityCounter += 1;
    const identity: EntityIdentity = {
      platform: obs.platform,
      handle: obs.handle,
      ...(obs.displayName ? { displayName: obs.displayName } : {}),
      verified: false,
      confidence: obs.confidence,
      addedAt: nowIso(),
      addedVia: "platform_observation",
      evidence: obs.evidence,
    };
    const entity: Entity = {
      entityId: `ent_${entityCounter}`,
      type: obs.suggestedType ?? "person",
      preferredName: obs.displayName ?? obs.handle,
      identities: [identity],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.entities.set(entity.entityId, entity);
    return { entity };
  }

  async resolve(_query: {
    name?: string;
    type?: string;
  }): Promise<EntityResolveCandidate[]> {
    const query = _query;
    return [...this.entities.values()]
      .filter(
        (entity) =>
          (!query.type || entity.type === query.type) &&
          (!query.name ||
            entity.preferredName
              .toLowerCase()
              .includes(query.name.toLowerCase())),
      )
      .map((entity) => ({
        entity,
        confidence:
          entity.preferredName.toLowerCase() === query.name?.toLowerCase()
            ? 0.9
            : 0.55,
        evidence: [],
        safeToSend: false,
      }));
  }

  async merge(targetId: string, sourceIds: string[]): Promise<Entity> {
    const target = this.entities.get(targetId);
    if (!target) throw new Error(`missing merge target ${targetId}`);
    const identities = [...target.identities];
    for (const sourceId of sourceIds) {
      const source = this.entities.get(sourceId);
      if (!source) continue;
      identities.push(...source.identities);
      this.entities.delete(sourceId);
    }
    const merged = { ...target, identities, updatedAt: nowIso() };
    this.entities.set(targetId, merged);
    return merged;
  }
}

class FakeRelationshipStore {
  relationships: Relationship[] = [];
  async observe(obs: {
    fromEntityId: string;
    toEntityId: string;
    type: string;
    evidence: string[];
    confidence: number;
    occurredAt?: string;
    source?: RelationshipSource;
  }): Promise<Relationship> {
    const rel: Relationship = {
      relationshipId: `rel_${this.relationships.length + 1}`,
      fromEntityId: obs.fromEntityId,
      toEntityId: obs.toEntityId,
      type: obs.type,
      metadata: {},
      confidence: obs.confidence,
      source: obs.source ?? "extraction",
      status: "active",
      evidence: obs.evidence,
      state: { lastObservedAt: nowIso(), interactionCount: 1 },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.relationships.push(rel);
    return rel;
  }
}

function makeRuntime(): {
  runtime: IAgentRuntime;
  emitted: Array<{ type: string; payload: Record<string, unknown> }>;
} {
  const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const runtime = {
    agentId: "agent-1",
    reportError: vi.fn(),
    emitEvent: vi.fn(async (type: string, payload: Record<string, unknown>) => {
      emitted.push({ type, payload });
    }),
  } as unknown as IAgentRuntime;
  return { runtime, emitted };
}

afterEach(() => {
  setVoiceObserverFactory(null);
  entityCounter = 0;
});

describe("handleVoiceTurnObserved", () => {
  it("creates an entity via the merge engine and emits VOICE_ENTITY_BOUND", async () => {
    const entityStore = new FakeEntityStore();
    const relationshipStore = new FakeRelationshipStore();
    setVoiceObserverFactory(
      async () =>
        new VoiceObserver({
          entityStore: entityStore as unknown as ConstructorParameters<
            typeof VoiceObserver
          >[0]["entityStore"],
          relationshipStore:
            relationshipStore as unknown as ConstructorParameters<
              typeof VoiceObserver
            >[0]["relationshipStore"],
        }),
    );

    const { runtime, emitted } = makeRuntime();
    await handleVoiceTurnObserved({
      runtime,
      turnId: "turn-jill-1",
      text: "hey there, I'm Jill",
      imprintClusterId: "cluster_jill",
      matchConfidence: 0.5,
      matchedEntityId: null,
      isOwner: false,
    });

    const entities = await entityStore.list();
    const jill = entities.find((e) => e.preferredName === "Jill");
    expect(jill).toBeDefined();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe(EventType.VOICE_ENTITY_BOUND);
    expect(emitted[0].payload).toMatchObject({
      imprintClusterId: "cluster_jill",
      entityId: jill?.entityId,
      displayName: "Jill",
      wasCreated: true,
    });
  });

  it("contains ingest failures — logs and does not emit or throw", async () => {
    setVoiceObserverFactory(async () => {
      throw new Error("store unavailable");
    });
    const { runtime, emitted } = makeRuntime();
    await expect(
      handleVoiceTurnObserved({
        runtime,
        turnId: "turn-x",
        text: "I'm Jill",
        imprintClusterId: "cluster_jill",
        matchConfidence: 0.5,
        matchedEntityId: null,
      }),
    ).resolves.toBeUndefined();
    expect(emitted).toHaveLength(0);
  });

  it("applies a confirmed correction through the merge engine without leaving duplicate entities", async () => {
    const entityStore = new FakeEntityStore();
    const relationshipStore = new FakeRelationshipStore();
    const first = await entityStore.observeIdentity({
      platform: "meeting",
      handle: "participant-sarah-a",
      displayName: "Sarah",
      evidence: ["roster-a"],
      confidence: 0.7,
      suggestedType: "person",
    });
    const second = await entityStore.observeIdentity({
      platform: "calendar",
      handle: "attendee-sarah-b",
      displayName: "Sarah",
      evidence: ["calendar-b"],
      confidence: 0.7,
      suggestedType: "person",
    });
    setVoiceObserverFactory(
      async () =>
        new VoiceObserver({
          entityStore: entityStore as unknown as ConstructorParameters<
            typeof VoiceObserver
          >[0]["entityStore"],
          relationshipStore:
            relationshipStore as unknown as ConstructorParameters<
              typeof VoiceObserver
            >[0]["relationshipStore"],
        }),
    );

    const { runtime, emitted } = makeRuntime();
    await handleVoiceTurnObserved({
      runtime,
      turnId: "turn-correction-sarah",
      text: "This is Sarah.",
      imprintClusterId: "cluster-speaker-2",
      matchConfidence: 1,
      matchedEntityId: null,
      speakerNameInference: {
        resolution: "confirmed",
        displayName: "Sarah",
        confidence: 1,
        candidateNames: [
          {
            name: "Sarah",
            normalizedName: "sarah",
            confidence: 1,
            sources: ["user_correction"],
            provenance: [
              {
                source: "user_correction",
                confidence: 1,
                evidenceId: "turn-correction-sarah",
              },
            ],
          },
        ],
        provenance: [
          {
            source: "user_correction",
            confidence: 1,
            evidenceId: "turn-correction-sarah",
          },
        ],
        reasonCodes: ["high_confidence_name", "user_correction_applied"],
        requiresReview: false,
      },
    });

    const sarahs = (await entityStore.list()).filter(
      (entity) => entity.preferredName === "Sarah",
    );
    expect(sarahs).toHaveLength(1);
    const expectedTargetId = [
      first.entity.entityId,
      second.entity.entityId,
    ].sort()[0];
    expect(sarahs[0]?.entityId).toBe(expectedTargetId);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: EventType.VOICE_ENTITY_BOUND,
      payload: {
        entityId: expectedTargetId,
        displayName: "Sarah",
        wasCreated: false,
        speakerNameInference: {
          resolution: "confirmed",
          displayName: "Sarah",
        },
      },
    });
  });

  it("withholds an ambiguous name decision without creating or binding an entity", async () => {
    const entityStore = new FakeEntityStore();
    const relationshipStore = new FakeRelationshipStore();
    setVoiceObserverFactory(
      async () =>
        new VoiceObserver({
          entityStore: entityStore as unknown as ConstructorParameters<
            typeof VoiceObserver
          >[0]["entityStore"],
          relationshipStore:
            relationshipStore as unknown as ConstructorParameters<
              typeof VoiceObserver
            >[0]["relationshipStore"],
        }),
    );

    const { runtime, emitted } = makeRuntime();
    await handleVoiceTurnObserved({
      runtime,
      turnId: "turn-ambiguous",
      text: "Speaker 2",
      imprintClusterId: "cluster-ambiguous",
      matchConfidence: 0.8,
      matchedEntityId: null,
      speakerNameInference: {
        resolution: "withheld",
        confidence: 0.82,
        candidateNames: [],
        provenance: [],
        reasonCodes: ["same_first_name_ambiguity"],
        requiresReview: true,
      },
    });

    expect(await entityStore.list()).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it("is registered on personalAssistantPlugin.events (runtime reachability, issue #8234)", async () => {
    // Companion assertion to test/voice-entity-binding.e2e.test.ts, which
    // exercises the cross-plugin round-trip but cannot import the lifeops
    // plugin barrel (it drags the @elizaos/agent server graph into the e2e
    // lane). Together they prove the registered handler IS this handler.
    const { personalAssistantPlugin } = await import("../../plugin.js");
    expect(
      personalAssistantPlugin.events?.[EventType.VOICE_TURN_OBSERVED],
    ).toContain(handleVoiceTurnObserved);
  });
});
