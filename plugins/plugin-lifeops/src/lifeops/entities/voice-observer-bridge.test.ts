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
    return [];
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
});
