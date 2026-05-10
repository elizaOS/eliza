/**
 * LifeOps relationships integration tests against a real PGLite runtime.
 *
 * Exercises the LifeOpsService relationship + follow-up surface and the
 * RELATIONSHIP action handler end-to-end. No SQL mocks, no LLM — the action
 * handler is invoked with an explicit `subaction` so the planner LLM path is
 * skipped and only the deterministic branches run.
 */

import type { AgentRuntime, IAgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/real-runtime";
import { relationshipAction } from "../src/actions/entity.ts";
import { LifeOpsRepository } from "../src/lifeops/repository.ts";
import { LifeOpsService } from "../src/lifeops/service.ts";
import {
  acceptCanonicalIdentityMerge,
  assertCanonicalIdentityMerged,
  getCanonicalIdentityGraph,
  getCanonicalPersonDetail,
  seedCanonicalIdentityFixture,
} from "./helpers/lifeops-identity-merge-fixtures.ts";

const AGENT_ID = "lifeops-relationships-agent";

function makeMessage(runtime: IAgentRuntime, text: string) {
  return {
    id: `msg-${Math.random()}` as string,
    entityId: runtime.agentId,
    roomId: runtime.agentId,
    content: { text },
  };
}

describe("relationships handler — real PGLite", () => {
  let runtime: AgentRuntime;
  let service: LifeOpsService;
  let testResult: RealTestRuntimeResult;

  beforeAll(async () => {
    testResult = await createRealTestRuntime({ characterName: AGENT_ID });
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

  it("createFollowUp + getDailyFollowUpQueue surface a due follow-up", async () => {
    const rel = await service.upsertRelationship({
      name: "Carol",
      primaryChannel: "email",
      primaryHandle: "carol@example.com",
      email: "carol@example.com",
      phone: null,
      notes: "",
      tags: [],
      relationshipType: "contact",
      lastContactedAt: null,
      metadata: {},
    });
    const yesterday = new Date(Date.now() - 86400_000).toISOString();
    const fu = await service.createFollowUp({
      relationshipId: rel.id,
      dueAt: yesterday,
      reason: "annual check-in",
      priority: 2,
      draft: null,
      completedAt: null,
      metadata: {},
    });
    const queue = await service.getDailyFollowUpQueue({});
    expect(queue.find((f) => f.id === fu.id)).toBeTruthy();
  });

  it("completeFollowUp removes it from the queue", async () => {
    const rel = await service.upsertRelationship({
      name: "Dan",
      primaryChannel: "email",
      primaryHandle: "dan@example.com",
      email: "dan@example.com",
      phone: null,
      notes: "",
      tags: [],
      relationshipType: "contact",
      lastContactedAt: null,
      metadata: {},
    });
    const yesterday = new Date(Date.now() - 86400_000).toISOString();
    const fu = await service.createFollowUp({
      relationshipId: rel.id,
      dueAt: yesterday,
      reason: "ping",
      priority: 3,
      draft: null,
      completedAt: null,
      metadata: {},
    });
    await service.completeFollowUp(fu.id);
    const queue = await service.getDailyFollowUpQueue({});
    expect(queue.find((f) => f.id === fu.id)).toBeFalsy();
  });

  it("relationshipAction list_contacts handler returns ActionResult", async () => {
    const result = await relationshipAction.handler!(
      runtime,
      makeMessage(runtime, "show me my contacts") as never,
      undefined,
      { parameters: { subaction: "list_contacts" } } as never,
      async () => {},
    );
    expect(result?.success).toBe(true);
    const data = (result as { data?: { contacts?: unknown[] } })
      .data;
    expect(Array.isArray(data?.contacts)).toBe(true);
  });

  it("relationshipAction add_contact handler persists a new contact", async () => {
    const result = await relationshipAction.handler!(
      runtime,
      makeMessage(runtime, "add Eve to rolodex") as never,
      undefined,
      {
        parameters: {
          subaction: "add_contact",
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

  it("relationshipAction add_contact rejects missing fields", async () => {
    const result = await relationshipAction.handler!(
      runtime,
      makeMessage(runtime, "add contact") as never,
      undefined,
      { parameters: { subaction: "add_contact", name: "OnlyName" } } as never,
      async () => {},
    );
    expect(result?.success).toBe(false);
    expect(
      (result as { data?: { error?: string } }).data?.error,
    ).toBe("MISSING_FIELDS");
  });

  it("relationshipAction add_follow_up resolves an existing contact by name and loose dueAt text", async () => {
    await service.upsertRelationship({
      name: "Dana Benchmark",
      primaryChannel: "email",
      primaryHandle: "dana.benchmark@example.com",
      email: "dana.benchmark@example.com",
      phone: null,
      notes: "Project contact.",
      tags: ["work"],
      relationshipType: "contact",
      lastContactedAt: null,
      metadata: {},
    });

    const result = await relationshipAction.handler!(
      runtime,
      makeMessage(
        runtime,
        "remind me to follow up with Dana next week about the project",
      ) as never,
      undefined,
      {
        parameters: {
          subaction: "add_follow_up",
          name: "Dana",
          reason: "Project follow-up",
          dueAt: "ISO-8601 date and time for next week",
        },
      } as never,
      async () => {},
    );

    expect(result?.success).toBe(true);
    const data = (
      result as {
        data?: { followUp?: { relationshipId: string; dueAt: string } };
      }
    ).data;
    expect(data?.followUp?.relationshipId).toBeTruthy();
    expect(data?.followUp?.dueAt).toContain("T");
  });

  it("relationshipAction days_since resolves an existing contact by name", async () => {
    const rel = await service.upsertRelationship({
      name: "Zora Benchmark",
      primaryChannel: "email",
      primaryHandle: "zora.benchmark@example.com",
      email: "zora.benchmark@example.com",
      phone: null,
      notes: "Project contact.",
      tags: ["work"],
      relationshipType: "contact",
      lastContactedAt: new Date(
        Date.now() - 9 * 24 * 60 * 60 * 1000,
      ).toISOString(),
      metadata: {},
    });

    const result = await relationshipAction.handler!(
      runtime,
      makeMessage(
        runtime,
        "how long has it been since I talked to Zora?",
      ) as never,
      undefined,
      {
        parameters: {
          subaction: "days_since",
          name: "Zora",
        },
      } as never,
      async () => {},
    );

    expect(result?.success).toBe(true);
    const data = (
      result as {
        data?: { relationshipId?: string; days?: number | null };
      }
    ).data;
    expect(data?.relationshipId).toBe(rel.id);
    expect(data?.days).toBeGreaterThanOrEqual(8);
  });

  it("relationshipAction days_since treats a non-UUID relationshipId as a contact name alias", async () => {
    const rel = await service.upsertRelationship({
      name: "Mina Benchmark",
      primaryChannel: "email",
      primaryHandle: "mina.benchmark@example.com",
      email: "mina.benchmark@example.com",
      phone: null,
      notes: "Project contact.",
      tags: ["work"],
      relationshipType: "contact",
      lastContactedAt: new Date(
        Date.now() - 4 * 24 * 60 * 60 * 1000,
      ).toISOString(),
      metadata: {},
    });

    const result = await relationshipAction.handler!(
      runtime,
      makeMessage(
        runtime,
        "how long has it been since I talked to Mina?",
      ) as never,
      undefined,
      {
        parameters: {
          subaction: "days_since",
          relationshipId: "Mina",
        },
      } as never,
      async () => {},
    );

    expect(result?.success).toBe(true);
    const data = (
      result as {
        data?: { relationshipId?: string; days?: number | null };
      }
    ).data;
    expect(data?.relationshipId).toBe(rel.id);
    expect(data?.days).toBeGreaterThanOrEqual(3);
  });

  it("relationshipAction days_since can resolve the contact from intent or message text when name fields are missing", async () => {
    const rel = await service.upsertRelationship({
      name: "Nadia Benchmark",
      primaryChannel: "email",
      primaryHandle: "nadia.benchmark@example.com",
      email: "nadia.benchmark@example.com",
      phone: null,
      notes: "Project contact.",
      tags: ["work"],
      relationshipType: "contact",
      lastContactedAt: new Date(
        Date.now() - 6 * 24 * 60 * 60 * 1000,
      ).toISOString(),
      metadata: {},
    });

    const result = await relationshipAction.handler!(
      runtime,
      makeMessage(
        runtime,
        "how long has it been since I talked to Nadia?",
      ) as never,
      undefined,
      {
        parameters: {
          subaction: "days_since",
          intent: "Nadia",
        },
      } as never,
      async () => {},
    );

    expect(result?.success).toBe(true);
    const data = (
      result as {
        data?: { relationshipId?: string; days?: number | null };
      }
    ).data;
    expect(data?.relationshipId).toBe(rel.id);
    expect(data?.days).toBeGreaterThanOrEqual(5);
  });

  it("relationshipAction executes a valid planned subaction even when the planner wrongly marks shouldAct=false", async () => {
    const rel = await service.upsertRelationship({
      name: "Omar Benchmark",
      primaryChannel: "email",
      primaryHandle: "omar.benchmark@example.com",
      email: "omar.benchmark@example.com",
      phone: null,
      notes: "Project contact.",
      tags: ["work"],
      relationshipType: "contact",
      lastContactedAt: new Date(
        Date.now() - 2 * 24 * 60 * 60 * 1000,
      ).toISOString(),
      metadata: {},
    });

    const originalUseModel = runtime.useModel.bind(runtime);
    runtime.useModel = (async (modelType, input) => {
      if (
        modelType === "TEXT_SMALL" &&
        typeof input === "object" &&
        input &&
        "prompt" in input &&
        typeof input.prompt === "string" &&
        input.prompt.includes(
          "Plan the RELATIONSHIP (Rolodex / follow-up) subaction",
        )
      ) {
        return JSON.stringify({
          subaction: "days_since",
          shouldAct: false,
          relationshipId: rel.id,
          response: "Omar, what have you been up to since we last talked?",
        });
      }
      return originalUseModel(modelType, input as never);
    }) as typeof runtime.useModel;

    try {
      const result = await relationshipAction.handler!(
        runtime,
        makeMessage(
          runtime,
          "how long has it been since I talked to Omar?",
        ) as never,
        undefined,
        { parameters: {} } as never,
        async () => {},
      );

      expect(result?.success).toBe(true);
      const data = (
        result as {
          data?: {
            relationshipId?: string;
            days?: number | null;
            noop?: boolean;
          };
        }
      ).data;
      expect(data?.noop).not.toBe(true);
      expect(data?.relationshipId).toBe(rel.id);
      expect(data?.days).toBeGreaterThanOrEqual(1);
    } finally {
      runtime.useModel = originalUseModel;
    }
  });

  it("relationshipAction list_overdue_followups respects per-contact thresholds", async () => {
    await service.upsertRelationship({
      name: "Threshold Dana",
      primaryChannel: "email",
      primaryHandle: "threshold.dana@example.com",
      email: "threshold.dana@example.com",
      phone: null,
      notes: "Threshold test contact.",
      tags: ["work"],
      relationshipType: "contact",
      lastContactedAt: new Date(
        Date.now() - 16 * 24 * 60 * 60 * 1000,
      ).toISOString(),
      metadata: { followupThresholdDays: 14 },
    });
    await service.upsertRelationship({
      name: "Threshold Evan",
      primaryChannel: "email",
      primaryHandle: "threshold.evan@example.com",
      email: "threshold.evan@example.com",
      phone: null,
      notes: "Threshold test contact.",
      tags: ["work"],
      relationshipType: "contact",
      lastContactedAt: new Date(
        Date.now() - 10 * 24 * 60 * 60 * 1000,
      ).toISOString(),
      metadata: { followupThresholdDays: 14 },
    });

    const result = await relationshipAction.handler!(
      runtime,
      makeMessage(runtime, "Who is overdue for follow-up?") as never,
      undefined,
      { parameters: { subaction: "list_overdue_followups" } } as never,
      async () => {},
    );

    expect(result?.success).toBe(true);
    const text = String(result?.text ?? "");
    expect(text).toContain("Threshold Dana");
    expect(text).not.toContain("Threshold Evan");
  });

  it("relationshipAction set_followup_threshold persists a new cadence rule", async () => {
    const rel = await service.upsertRelationship({
      name: "Cadence Mina",
      primaryChannel: "email",
      primaryHandle: "cadence.mina@example.com",
      email: "cadence.mina@example.com",
      phone: null,
      notes: "Cadence contact.",
      tags: ["work"],
      relationshipType: "contact",
      lastContactedAt: null,
      metadata: {},
    });

    const result = await relationshipAction.handler!(
      runtime,
      makeMessage(runtime, "Set Mina to every 14 days") as never,
      undefined,
      {
        parameters: {
          subaction: "set_followup_threshold",
          relationshipId: rel.id,
          thresholdDays: 14,
        },
      } as never,
      async () => {},
    );

    expect(result?.success).toBe(true);
    const updated = await service.getRelationship(rel.id);
    expect(updated?.metadata.followupThresholdDays).toBe(14);
  });

  it("relationshipAction mark_followup_done updates last contact and clears pending follow-ups for that person", async () => {
    const rel = await service.upsertRelationship({
      name: "Frontier Tower Loop",
      primaryChannel: "telegram",
      primaryHandle: "@frontiertower",
      email: null,
      phone: null,
      notes: "Loop closure contact.",
      tags: ["vendor"],
      relationshipType: "vendor",
      lastContactedAt: new Date(
        Date.now() - 21 * 24 * 60 * 60 * 1000,
      ).toISOString(),
      metadata: {},
    });
    const followUp = await service.createFollowUp({
      relationshipId: rel.id,
      dueAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      reason: "Repair the missed walkthrough and reschedule.",
      priority: 1,
      draft: null,
      completedAt: null,
      metadata: {},
    });

    const result = await relationshipAction.handler!(
      runtime,
      makeMessage(
        runtime,
        "They confirmed Thursday works. Mark the Frontier Tower Loop follow-up done and close the loop.",
      ) as never,
      undefined,
      {
        parameters: {
          subaction: "mark_followup_done",
          relationshipId: rel.id,
          reason: "Thursday confirmed",
        },
      } as never,
      async () => {},
    );

    expect(result?.success).toBe(true);
    const updated = await service.getRelationship(rel.id);
    expect(updated?.lastContactedAt).toBeTruthy();
    const refreshedFollowUps = await service.listFollowUps({ limit: 20 });
    expect(
      refreshedFollowUps.find((entry) => entry.id === followUp.id)?.status,
    ).toBe("completed");
  });

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
    expect(before.people).toHaveLength(4);

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
    expect(detail?.memberEntityIds).toHaveLength(4);
    expect(detail?.identities).toHaveLength(4);
    expect(detail?.recentConversations).toHaveLength(4);
    expect(detail?.identityEdges).toHaveLength(3);
    const transcript =
      detail?.recentConversations
        .flatMap((entry) => entry.messages.map((message) => message.text))
        .join("\n") ?? "";
    expect(transcript).toContain("Gmail:");
    expect(transcript).toContain("Signal:");
    expect(transcript).toContain("Telegram:");
    expect(transcript).toContain("WhatsApp:");
  });
});
