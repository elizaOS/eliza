/**
 * LifeOps relationship behavior against a real PGLite runtime, including the
 * hard boundary that keeps identity verification and merges out of chat.
 */
import { KnowledgeGraphService, knowledgeGraphSchema } from "@elizaos/agent";
import type {
  ActionResult,
  AgentRuntime,
  EffectReceipt,
  IAgentRuntime,
  Plugin,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/app-core/test/helpers/real-runtime.ts";
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

const knowledgeGraphPlugin: Plugin = {
  name: "eliza",
  description: "Test-only knowledge-graph schema + service registration.",
  schema: knowledgeGraphSchema,
  services: [KnowledgeGraphService],
  actions: [entityAction],
};

function makeMessage(runtime: IAgentRuntime, text: string) {
  return {
    id: `msg-${crypto.randomUUID()}`,
    entityId: runtime.agentId,
    roomId: runtime.agentId,
    content: { text },
  };
}

function handler() {
  if (!entityAction.handler) throw new Error("ENTITY handler is required");
  return entityAction.handler;
}

function receipt(result: ActionResult | undefined): EffectReceipt {
  expect(result?.effectReceipts).toHaveLength(1);
  const value = result?.effectReceipts?.[0];
  if (!value) throw new Error("Expected one entity effect receipt");
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

  it("persists contacts and interactions through deterministic services", async () => {
    const relationship = await service.upsertRelationship({
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
    await service.logInteraction({
      relationshipId: relationship.id,
      channel: "email",
      direction: "outbound",
      summary: "checked in",
      occurredAt: new Date().toISOString(),
      metadata: {},
    });

    expect(
      (await service.listRelationships({})).find(
        (entry) => entry.id === relationship.id,
      ),
    ).toBeTruthy();
    expect(await service.getDaysSinceContact(relationship.id)).toBe(0);
  });

  it("keeps supported ENTITY writes receipt-backed", async () => {
    const result = await handler()(
      runtime,
      makeMessage(runtime, "add Eve to rolodex") as never,
      undefined,
      {
        parameters: {
          subaction: "create",
          name: "Eve",
          channel: "telegram",
          handle: "@eve",
        },
      } as never,
      async () => {},
    );

    expect(result.success).toBe(true);
    expect(receipt(result)).toMatchObject({
      outcome: "applied",
      operation: "lifeops.entity.contact.save",
      commit: { kind: "durable" },
    });
  });

  it.each([
    {
      subaction: "set_identity",
      extra: {
        platform: "telegram",
        handle: "@model_claim",
        verified: true,
        confirmed: true,
        confidence: 1,
      },
    },
    {
      subaction: "merge",
      extra: {
        entityId: "target",
        sourceEntityIds: ["source"],
        confirmed: true,
      },
    },
  ])(
    "rejects model-authored $subaction without premature mutation",
    async ({ subaction, extra }) => {
      const entityStore = await new LifeOpsRepository(runtime).entityStore(
        runtime.agentId,
      );
      const before = await entityStore.list({ limit: 1_000 });
      const result = await handler()(
        runtime,
        makeMessage(runtime, `please ${subaction}`) as never,
        undefined,
        { parameters: { subaction, ...extra } } as never,
        async () => {},
      );
      const after = await entityStore.list({ limit: 1_000 });

      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({
        error: "IDENTITY_AUTHORITY_REQUIRED",
        requestedSubaction: subaction,
      });
      expect(after).toEqual(before);
    },
  );

  it("does not advertise identity mutation operations or confirmation", () => {
    const actionParameter = entityAction.parameters?.find(
      (parameter) => parameter.name === "action",
    );
    expect(actionParameter?.schema).toMatchObject({
      enum: ["create", "read", "log_interaction", "set_relationship"],
    });
    expect(
      entityAction.parameters?.map((parameter) => parameter.name),
    ).not.toEqual(
      expect.arrayContaining([
        "confirmed",
        "platform",
        "displayName",
        "connectorAccountId",
        "sourceEntityIds",
      ]),
    );
  });

  it("allows deterministic graph authority to merge platform principals", async () => {
    const fixture = await seedCanonicalIdentityFixture({
      runtime,
      seedKey: "real-graph-merge",
      personName: "Priya Rao Graph Merge",
    });
    await acceptCanonicalIdentityMerge(runtime, fixture);

    expect(
      await assertCanonicalIdentityMerged({
        runtime,
        personName: fixture.personName,
      }),
    ).toBeUndefined();
    const snapshot = await (
      await getCanonicalIdentityGraph(runtime)
    ).getGraphSnapshot({ search: fixture.personName, limit: 10 });
    expect(snapshot.people).toHaveLength(1);
    expect(snapshot.people[0]?.primaryEntityId).toBe(fixture.primaryEntityId);
  });

  it("preserves deterministic merge evidence in person detail", async () => {
    const fixture = await seedCanonicalIdentityFixture({
      runtime,
      seedKey: "real-person-detail",
      personName: "Priya Rao Detail",
    });
    await acceptCanonicalIdentityMerge(runtime, fixture);

    const detail = await getCanonicalPersonDetail(runtime, fixture.personName);
    expect(detail?.memberEntityIds).toHaveLength(
      CANONICAL_IDENTITY_PLATFORMS.length,
    );
    expect(detail?.identities).toHaveLength(
      CANONICAL_IDENTITY_PLATFORMS.length,
    );
    expect(detail?.identityEdges).toHaveLength(
      CANONICAL_IDENTITY_PLATFORMS.length - 1,
    );
  });
});
