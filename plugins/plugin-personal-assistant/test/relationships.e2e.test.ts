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
import type { AgentRuntime, IAgentRuntime, Plugin } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    const data = (
      result as {
        data?: { relationship?: { id: string; name: string } };
      }
    ).data;
    expect(data?.relationship?.name).toBe("Eve");
    const list = await service.listRelationships({});
    expect(list.find((r) => r.name === "Eve")).toBeTruthy();
  });

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
