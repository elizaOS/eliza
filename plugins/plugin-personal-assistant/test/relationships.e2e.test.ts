/**
 * LifeOps relationships integration tests against a real PGLite runtime.
 *
 * Exercises the LifeOpsService relationship surface and the canonical
 * ENTITY action handler end-to-end. No SQL mocks, no LLM — the action
 * handler is invoked with an explicit `subaction` so the planner LLM path
 * is skipped and only the deterministic branches run. Follow-up cadence
 * lives on `SCHEDULED_TASK` and is covered by `scheduled-task-action.test.ts`.
 */

import { KnowledgeGraphService, knowledgeGraphSchema } from "@elizaos/agent";
import type {
  ActionResult,
  AgentRuntime,
  EffectReceipt,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  Plugin,
  UUID,
} from "@elizaos/core";
import { executePlannedToolCall } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/test/helpers/real-runtime.ts";
import { entityAction } from "../src/actions/entity.ts";
import { LifeOpsRepository } from "../src/lifeops/repository.ts";
import { LifeOpsService } from "../src/lifeops/service.ts";
import {
  acceptCanonicalIdentityMerge,
  assertCanonicalIdentityMerged,
  CANONICAL_IDENTITY_PLATFORMS,
  getCanonicalIdentityGraph,
  getCanonicalPersonDetail,
  seedCanonicalIdentityFixture,
} from "./helpers/lifeops-identity-merge-fixtures.ts";

const AGENT_ID = "lifeops-relationships-agent";

/**
 * Minimal stand-in for the production "eliza" plugin: registers the
 * knowledge-graph schema + KnowledgeGraphService so contacts (which live in
 * the runtime graph) resolve through `resolveKnowledgeGraphService`.
 */
const knowledgeGraphPlugin: Plugin = {
  name: "eliza",
  description: "Test-only knowledge-graph schema + service registration.",
  schema: knowledgeGraphSchema,
  services: [KnowledgeGraphService],
  actions: [entityAction],
};

function makeMessage(runtime: IAgentRuntime, text: string) {
  return {
    id: `msg-${Math.random()}` as string,
    entityId: runtime.agentId,
    roomId: runtime.agentId,
    content: { text },
  };
}

function getEntityActionHandler() {
  const { handler } = entityAction;
  if (!handler) {
    throw new Error("entityAction handler is required for relationships tests");
  }
  return handler;
}

function receipt(result: ActionResult | undefined): EffectReceipt {
  expect(result?.effectReceipts).toHaveLength(1);
  const value = result?.effectReceipts?.[0];
  if (!value) {
    throw new Error("Expected one entity effect receipt");
  }
  expect(result?.userFacingEffectReceiptIds).toEqual([value.receiptId]);
  return value;
}

describe("relationships handler — real PGLite", () => {
  let runtime: AgentRuntime;
  let service: LifeOpsService;
  let testResult: RealTestRuntimeResult;

  beforeAll(async () => {
    testResult = await createRealTestRuntime({
      characterName: AGENT_ID,
      plugins: [knowledgeGraphPlugin],
    });
    runtime = testResult.runtime;
    await LifeOpsRepository.bootstrapSchema(runtime);
    service = new LifeOpsService(runtime);
  }, 180_000);

  afterAll(async () => {
    await testResult?.cleanup();
  });

  it("upsertRelationship persists and listRelationships returns it", async () => {
    const rel = await service.upsertRelationship({
      name: "Alice",
      primaryChannel: "email",
      primaryHandle: "alice@example.com",
      email: "alice@example.com",
      phone: null,
      notes: "test",
      tags: ["friend"],
      relationshipType: "friend",
      lastContactedAt: null,
      metadata: {},
    });
    expect(rel.id).toBeTruthy();
    const list = await service.listRelationships({});
    expect(list.find((r) => r.id === rel.id)).toBeTruthy();
  });

  it("logInteraction updates lastContactedAt and getDaysSinceContact returns 0", async () => {
    const rel = await service.upsertRelationship({
      name: "Bob",
      primaryChannel: "email",
      primaryHandle: "bob@example.com",
      email: "bob@example.com",
      phone: null,
      notes: "",
      tags: [],
      relationshipType: "contact",
      lastContactedAt: null,
      metadata: {},
    });
    await service.logInteraction({
      relationshipId: rel.id,
      channel: "email",
      direction: "outbound",
      summary: "checked in",
      occurredAt: new Date().toISOString(),
      metadata: {},
    });
    const days = await service.getDaysSinceContact(rel.id);
    expect(days).toBe(0);
  });

  it("entityAction list handler returns ActionResult", async () => {
    const result = await getEntityActionHandler()(
      runtime,
      makeMessage(runtime, "show me my contacts") as never,
      undefined,
      { parameters: { subaction: "list" } } as never,
      async () => {},
    );
    expect(result?.success).toBe(true);
    expect(receipt(result)).toMatchObject({
      outcome: "noop",
      operation: "lifeops.entity.read",
      resource: { kind: "lifeops.entity.catalog" },
    });
    const data = (result as { data?: { contacts?: unknown[] } }).data;
    expect(Array.isArray(data?.contacts)).toBe(true);
  });

  it("entityAction add handler persists a new contact", async () => {
    const result = await getEntityActionHandler()(
      runtime,
      makeMessage(runtime, "add Eve to rolodex") as never,
      undefined,
      {
        parameters: {
          subaction: "add",
          name: "Eve",
          channel: "telegram",
          handle: "@eve",
        },
      } as never,
      async () => {},
    );
    expect(result?.success).toBe(true);
    const applied = receipt(result);
    expect(applied).toMatchObject({
      outcome: "applied",
      operation: "lifeops.entity.contact.save",
      resource: {
        kind: "lifeops.entity.contact",
        id: expect.any(String),
        version: expect.any(String),
      },
      commit: {
        kind: "durable",
        id: expect.any(String),
        committedAt: expect.any(String),
      },
    });
    const data = (
      result as {
        data?: { relationship?: { id: string; name: string } };
      }
    ).data;
    expect(data?.relationship?.name).toBe("Eve");
    const list = await service.listRelationships({});
    expect(list.find((r) => r.name === "Eve")).toBeTruthy();
  });

  it("delivers an authenticated receipt id through the canonical action executor", async () => {
    const callback = vi.fn<HandlerCallback>(async () => []);
    const message = {
      id: crypto.randomUUID() as UUID,
      agentId: runtime.agentId,
      entityId: runtime.agentId,
      roomId: crypto.randomUUID() as UUID,
      content: {
        source: "autonomy",
        text: "Add receipt-backed contact Rowan",
      },
      createdAt: Date.now(),
    } as Memory;

    const result = await executePlannedToolCall(
      runtime,
      {
        message,
        callback,
        userRoles: ["OWNER"],
        activeContexts: ["contacts"],
      },
      {
        name: "ENTITY",
        params: {
          subaction: "create",
          name: `Rowan ${crypto.randomUUID()}`,
          channel: "signal",
          handle: `+1${Date.now()}`,
        },
      },
    );

    const applied = receipt(result);
    expect(applied).toMatchObject({
      outcome: "applied",
      operation: "lifeops.entity.contact.save",
    });
    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0]?.[0]).toMatchObject({
      text: result.text,
      effectReceiptIds: [applied.receiptId],
    });
  }, 120_000);

  it("binds interaction, identity, relationship, and merge writes to persisted resources", async () => {
    const contact = await service.upsertRelationship({
      name: `Receipt Contact ${crypto.randomUUID()}`,
      primaryChannel: "email",
      primaryHandle: `receipt-${crypto.randomUUID()}@example.com`,
      email: null,
      phone: null,
      notes: "",
      tags: [],
      relationshipType: "contact",
      lastContactedAt: null,
      metadata: {},
    });
    const logged = await getEntityActionHandler()(
      runtime,
      makeMessage(runtime, "log that I checked in") as never,
      undefined,
      {
        parameters: {
          subaction: "log_interaction",
          relationshipId: contact.id,
          channel: "email",
          notes: "receipt-backed check-in",
        },
      } as never,
      async () => {},
    );
    expect(receipt(logged)).toMatchObject({
      outcome: "applied",
      operation: "lifeops.entity.interaction.log",
      resource: {
        kind: "lifeops.entity.interaction",
        id: expect.any(String),
      },
      commit: { kind: "durable", id: expect.any(String) },
    });

    const primaryIdentity = await getEntityActionHandler()(
      runtime,
      makeMessage(runtime, "record this identity") as never,
      undefined,
      {
        parameters: {
          subaction: "set_identity",
          platform: "signal",
          handle: `+1${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`,
          displayName: "Receipt Identity Primary",
        },
      } as never,
      async () => {},
    );
    const primaryReceipt = receipt(primaryIdentity);
    expect(primaryReceipt).toMatchObject({
      outcome: "applied",
      operation: "lifeops.entity.identity.set",
      resource: {
        kind: "lifeops.entity",
        id: expect.any(String),
        version: expect.any(String),
      },
      commit: { kind: "durable", id: expect.any(String) },
    });
    const primaryEntityId = (
      primaryIdentity.data as { entity: { entityId: string } }
    ).entity.entityId;

    const targetedIdentity = await getEntityActionHandler()(
      runtime,
      makeMessage(runtime, "attach the email identity to that entity") as never,
      undefined,
      {
        parameters: {
          subaction: "set_identity",
          entityId: primaryEntityId,
          platform: "email",
          handle: `receipt-${crypto.randomUUID()}@example.com`,
          displayName: "Receipt Identity Primary",
        },
      } as never,
      async () => {},
    );
    expect(receipt(targetedIdentity)).toMatchObject({
      outcome: "applied",
      operation: "lifeops.entity.identity.set",
      resource: { kind: "lifeops.entity", id: primaryEntityId },
      commit: { kind: "durable", id: primaryEntityId },
    });
    expect(
      (targetedIdentity.data as { entity: { entityId: string } }).entity
        .entityId,
    ).toBe(primaryEntityId);

    const secondaryIdentity = await getEntityActionHandler()(
      runtime,
      makeMessage(runtime, "record another identity") as never,
      undefined,
      {
        parameters: {
          subaction: "set_identity",
          platform: "telegram",
          handle: `@receipt_${crypto.randomUUID().replaceAll("-", "")}`,
          displayName: "Receipt Identity Secondary",
        },
      } as never,
      async () => {},
    );
    const secondaryEntityId = (
      secondaryIdentity.data as { entity: { entityId: string } }
    ).entity.entityId;

    const related = await getEntityActionHandler()(
      runtime,
      makeMessage(runtime, "record the relationship") as never,
      undefined,
      {
        parameters: {
          subaction: "set_relationship",
          fromEntityId: "self",
          toEntityId: primaryEntityId,
          relationshipType: "knows",
        },
      } as never,
      async () => {},
    );
    expect(receipt(related)).toMatchObject({
      outcome: "applied",
      operation: "lifeops.entity.relationship.set",
      resource: {
        kind: "lifeops.entity.relationship",
        id: expect.any(String),
      },
      commit: { kind: "durable", id: expect.any(String) },
    });

    const merged = await getEntityActionHandler()(
      runtime,
      makeMessage(runtime, "merge the duplicate identity") as never,
      undefined,
      {
        parameters: {
          subaction: "merge",
          entityId: primaryEntityId,
          sourceEntityIds: [secondaryEntityId],
        },
      } as never,
      async () => {},
    );
    expect(receipt(merged)).toMatchObject({
      outcome: "applied",
      operation: "lifeops.entity.merge",
      resource: {
        kind: "lifeops.entity",
        id: primaryEntityId,
        version: expect.any(String),
      },
      artifacts: [
        {
          kind: "lifeops.entity.merge_source",
          id: secondaryEntityId,
        },
      ],
      commit: { kind: "durable", id: primaryEntityId },
    });
    const entityStore = await new LifeOpsRepository(runtime).entityStore(
      runtime.agentId,
    );
    expect(await entityStore.get(secondaryEntityId)).toBeNull();
    expect((await entityStore.get(primaryEntityId))?.identities).toHaveLength(
      3,
    );
  }, 120_000);

  it("requires confirmation before a targeted identity claim merges a conflicting entity", async () => {
    const first = await getEntityActionHandler()(
      runtime,
      makeMessage(runtime, "record the first identity") as never,
      undefined,
      {
        parameters: {
          subaction: "set_identity",
          platform: "signal",
          handle: `+1${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`,
          displayName: "Targeted Identity",
        },
      } as never,
      async () => {},
    );
    const targetEntityId = (first.data as { entity: { entityId: string } })
      .entity.entityId;
    const conflictingHandle = `@conflict_${crypto.randomUUID().replaceAll("-", "")}`;
    const second = await getEntityActionHandler()(
      runtime,
      makeMessage(runtime, "record the other identity") as never,
      undefined,
      {
        parameters: {
          subaction: "set_identity",
          platform: "telegram",
          handle: conflictingHandle,
          displayName: "Conflicting Identity",
        },
      } as never,
      async () => {},
    );
    const sourceEntityId = (second.data as { entity: { entityId: string } })
      .entity.entityId;
    const entityStore = await new LifeOpsRepository(runtime).entityStore(
      runtime.agentId,
    );

    const unconfirmed = await getEntityActionHandler()(
      runtime,
      makeMessage(runtime, "put that handle on the first person") as never,
      undefined,
      {
        parameters: {
          subaction: "set_identity",
          entityId: targetEntityId,
          platform: "telegram",
          handle: conflictingHandle,
        },
      } as never,
      async () => {},
    );
    expect(unconfirmed.success).toBe(false);
    expect((unconfirmed.data as { error?: string } | undefined)?.error).toBe(
      "IDENTITY_CONFLICT",
    );
    expect(await entityStore.get(sourceEntityId)).not.toBeNull();
    expect(await entityStore.get(targetEntityId)).not.toBeNull();

    const confirmed = await getEntityActionHandler()(
      runtime,
      makeMessage(runtime, "yes, merge those identities") as never,
      undefined,
      {
        parameters: {
          subaction: "set_identity",
          entityId: targetEntityId,
          platform: "telegram",
          handle: conflictingHandle,
          confirmed: true,
        },
      } as never,
      async () => {},
    );
    expect(receipt(confirmed)).toMatchObject({
      outcome: "applied",
      operation: "lifeops.entity.identity.set",
      resource: { id: targetEntityId },
      artifacts: [
        {
          kind: "lifeops.entity.merge_source",
          id: sourceEntityId,
        },
      ],
      commit: { kind: "durable", id: targetEntityId },
    });
    expect(await entityStore.get(sourceEntityId)).toBeNull();
    expect(
      (await entityStore.get(targetEntityId))?.identities.some(
        (identity) =>
          identity.platform === "telegram" &&
          identity.handle === conflictingHandle &&
          identity.verified,
      ),
    ).toBe(true);
  }, 120_000);

  it("entityAction add rejects missing fields", async () => {
    const result = await getEntityActionHandler()(
      runtime,
      makeMessage(runtime, "add contact") as never,
      undefined,
      { parameters: { subaction: "add", name: "OnlyName" } } as never,
      async () => {},
    );
    expect(result?.success).toBe(false);
    expect((result as { data?: { error?: string } }).data?.error).toBe(
      "MISSING_FIELDS",
    );
  });

  // Follow-up cadence (`days_since`, `list_overdue_followups`,
  // `set_followup_threshold`) lives on the SCHEDULED_TASK umbrella. Overdue
  // follow-ups are derived from contact cadence by `computeOverdueFollowups`
  // (followup-tracker) over the runtime knowledge graph; there is no separate
  // LifeOps follow-up table. These are exercised by the followup-tracker tests
  // and `scheduled-task-action.test.ts`.

  it("relationships graph collapses a four-platform person into one canonical node after accepted merges", async () => {
    const fixture = await seedCanonicalIdentityFixture({
      runtime,
      seedKey: "real-graph-merge",
      personName: "Priya Rao Graph Merge",
    });

    const before = await (
      await getCanonicalIdentityGraph(runtime)
    ).getGraphSnapshot({
      search: fixture.personName,
      limit: 10,
    });
    expect(before.people).toHaveLength(CANONICAL_IDENTITY_PLATFORMS.length);

    await acceptCanonicalIdentityMerge(runtime, fixture);

    const mergedCheck = await assertCanonicalIdentityMerged({
      runtime,
      personName: fixture.personName,
    });
    expect(mergedCheck).toBeUndefined();

    const after = await (
      await getCanonicalIdentityGraph(runtime)
    ).getGraphSnapshot({
      search: fixture.personName,
      limit: 10,
    });
    expect(after.people).toHaveLength(1);
    expect(after.people[0]?.primaryEntityId).toBe(fixture.primaryEntityId);
  });

  it("person detail exposes all merged identities and cross-platform conversations", async () => {
    const fixture = await seedCanonicalIdentityFixture({
      runtime,
      seedKey: "real-person-detail",
      personName: "Priya Rao Detail",
    });
    await acceptCanonicalIdentityMerge(runtime, fixture);

    const detail = await getCanonicalPersonDetail(runtime, fixture.personName);
    expect(detail).toBeTruthy();
    expect(detail?.memberEntityIds).toHaveLength(
      CANONICAL_IDENTITY_PLATFORMS.length,
    );
    expect(detail?.identities).toHaveLength(
      CANONICAL_IDENTITY_PLATFORMS.length,
    );
    expect(detail?.recentConversations).toHaveLength(
      CANONICAL_IDENTITY_PLATFORMS.length,
    );
    expect(detail?.identityEdges).toHaveLength(
      CANONICAL_IDENTITY_PLATFORMS.length - 1,
    );
    const transcript =
      detail?.recentConversations
        .flatMap((entry) => entry.messages.map((message) => message.text))
        .join("\n") ?? "";
    expect(transcript).toContain("Gmail:");
    expect(transcript).toContain("Signal:");
    expect(transcript).toContain("Telegram:");
    expect(transcript).toContain("WhatsApp:");
    expect(transcript).toContain("Discord:");
  });
});
