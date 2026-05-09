/**
 * Tests for the EntityStore — multi-identity upsert, observeIdentity merge
 * with provenance, resolve with multiple candidates, recordInteraction,
 * and explicit merge.
 *
 * Runs against a real PGLite-backed runtime via createRealTestRuntime.
 */

import type { AgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/real-runtime";
import { EntityStore } from "../src/lifeops/entities/store";
import type { EntityIdentity } from "../src/lifeops/entities/types";
import { SELF_ENTITY_ID } from "../src/lifeops/entities/types";
import { LifeOpsRepository } from "../src/lifeops/repository";

describe("EntityStore — real PGLite", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;
  let store: EntityStore;
  const agentId = "entitystore-tests";

  beforeAll(async () => {
    testResult = await createRealTestRuntime({ characterName: agentId });
    runtime = testResult.runtime;
    await LifeOpsRepository.bootstrapSchema(runtime);
    store = new EntityStore(runtime, agentId);
    await store.ensureSelf();
  }, 180_000);

  afterAll(async () => {
    await testResult?.cleanup();
  });

  it("ensureSelf bootstraps and is idempotent", async () => {
    const a = await store.ensureSelf();
    const b = await store.ensureSelf();
    expect(a.entityId).toBe(SELF_ENTITY_ID);
    expect(b.entityId).toBe(SELF_ENTITY_ID);
    expect(b.createdAt).toBe(a.createdAt);
  });

  it("upsert creates an entity with multiple identities", async () => {
    const identities: EntityIdentity[] = [
      {
        platform: "telegram",
        handle: "@alice",
        verified: true,
        confidence: 1,
        addedAt: new Date().toISOString(),
        addedVia: "user_chat",
        evidence: ["obs-1"],
      },
      {
        platform: "gmail",
        handle: "alice@example.com",
        verified: true,
        confidence: 1,
        addedAt: new Date().toISOString(),
        addedVia: "user_chat",
        evidence: ["obs-1"],
      },
    ];
    const entity = await store.upsert({
      type: "person",
      preferredName: "Alice",
      identities,
      tags: ["friend"],
      visibility: "owner_agent_admin",
      state: {},
    });
    expect(entity.identities).toHaveLength(2);
    const fetched = await store.get(entity.entityId);
    expect(fetched?.identities).toHaveLength(2);
    expect(fetched?.tags).toEqual(["friend"]);
  });

  it("observeIdentity collapses entities by (platform, handle) with provenance", async () => {
    // Seed an entity with a Discord handle.
    const seeded = await store.upsert({
      type: "person",
      preferredName: "Pat",
      identities: [
        {
          platform: "discord",
          handle: "patsmith",
          verified: true,
          confidence: 0.95,
          addedAt: new Date().toISOString(),
          addedVia: "user_chat",
          evidence: ["seed-1"],
        },
      ],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });

    const result = await store.observeIdentity({
      platform: "discord",
      handle: "patsmith",
      displayName: "Pat S.",
      evidence: ["obs-2"],
      confidence: 0.95,
    });
    expect(result.entity.entityId).toBe(seeded.entityId);
    expect(result.mergedFrom).toEqual([seeded.entityId]);
    const fetched = await store.get(seeded.entityId);
    const identity = fetched?.identities.find(
      (id) => id.platform === "discord" && id.handle === "patsmith",
    );
    expect(identity?.evidence).toContain("seed-1");
    expect(identity?.evidence).toContain("obs-2");
  });

  it("observeIdentity creates a new entity when no candidate matches", async () => {
    const result = await store.observeIdentity({
      platform: "x",
      handle: "@brandnew",
      evidence: ["obs-x"],
      confidence: 0.9,
    });
    expect(result.entity.entityId).not.toBe(SELF_ENTITY_ID);
    expect(result.entity.identities).toHaveLength(1);
    expect(result.entity.identities[0]?.platform).toBe("x");
  });

  it("observeIdentity surfaces conflict when multiple candidates match", async () => {
    // Two pre-existing entities both claiming the same email handle.
    const a = await store.upsert({
      type: "person",
      preferredName: "Conflict A",
      identities: [
        {
          platform: "email",
          handle: "shared@conflict.com",
          verified: false,
          confidence: 0.6,
          addedAt: new Date().toISOString(),
          addedVia: "platform_observation",
          evidence: ["a"],
        },
      ],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });
    const b = await store.upsert({
      type: "person",
      preferredName: "Conflict B",
      identities: [
        {
          platform: "email",
          handle: "shared@conflict.com",
          verified: false,
          confidence: 0.6,
          addedAt: new Date().toISOString(),
          addedVia: "platform_observation",
          evidence: ["b"],
        },
      ],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });

    const result = await store.observeIdentity({
      platform: "email",
      handle: "shared@conflict.com",
      evidence: ["obs-conflict"],
      confidence: 0.7,
    });
    expect(result.conflict).toBe(true);
    expect(result.mergedFrom?.sort()).toEqual([a.entityId, b.entityId].sort());
  });

  it("resolve returns ranked candidates by name", async () => {
    await store.upsert({
      type: "person",
      preferredName: "ResolveTest",
      identities: [],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });
    const candidates = await store.resolve({
      name: "ResolveTest",
      type: "person",
    });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]?.entity.preferredName).toBe("ResolveTest");
  });

  it("resolve with identity narrows to exact (platform, handle)", async () => {
    await store.upsert({
      type: "person",
      preferredName: "IdentityResolve",
      identities: [
        {
          platform: "telegram",
          handle: "identity_resolve",
          verified: true,
          confidence: 1,
          addedAt: new Date().toISOString(),
          addedVia: "user_chat",
          evidence: ["ir"],
        },
      ],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });
    const result = await store.resolve({
      identity: { platform: "telegram", handle: "identity_resolve" },
    });
    expect(result.length).toBe(1);
    expect(result[0]?.safeToSend).toBe(true);
  });

  it("recordInteraction updates state.lastInboundAt and lastInteractionPlatform", async () => {
    const entity = await store.upsert({
      type: "person",
      preferredName: "Interactor",
      identities: [],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });
    const occurredAt = new Date("2026-05-01T10:00:00Z").toISOString();
    await store.recordInteraction(entity.entityId, {
      platform: "telegram",
      direction: "inbound",
      summary: "ping",
      occurredAt,
    });
    const fetched = await store.get(entity.entityId);
    expect(fetched?.state.lastInboundAt).toBe(occurredAt);
    expect(fetched?.state.lastInteractionPlatform).toBe("telegram");
  });

  it("merge folds source identities into target and removes the source row", async () => {
    const target = await store.upsert({
      type: "person",
      preferredName: "MergeTarget",
      identities: [
        {
          platform: "email",
          handle: "target@example.com",
          verified: true,
          confidence: 1,
          addedAt: new Date().toISOString(),
          addedVia: "user_chat",
          evidence: ["t"],
        },
      ],
      tags: ["original"],
      visibility: "owner_agent_admin",
      state: {},
    });
    const source = await store.upsert({
      type: "person",
      preferredName: "MergeSource",
      identities: [
        {
          platform: "telegram",
          handle: "@mergesource",
          verified: true,
          confidence: 1,
          addedAt: new Date().toISOString(),
          addedVia: "platform_observation",
          evidence: ["s"],
        },
      ],
      tags: ["folded"],
      visibility: "owner_agent_admin",
      state: {},
    });
    const merged = await store.merge(target.entityId, [source.entityId]);
    expect(merged.identities.length).toBe(2);
    expect(merged.tags).toContain("original");
    expect(merged.tags).toContain("folded");
    expect(await store.get(source.entityId)).toBeNull();
  });
});
