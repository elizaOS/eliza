/**
 * `BRIEF` umbrella action — unit tests (W2-5).
 *
 * Asserts that the morning / evening / weekly briefing surface exposed by
 * the PRD §Daily Operations exists, composes structured sections from the
 * injected loaders, and dispatches via simile names. The narrative tests pin
 * the compose PIPELINE around the canned model reply — the prompt must carry
 * every aggregated section, the reply is trimmed before it lands on the
 * briefing, and a throwing / non-string / whitespace-only model degrades to
 * a narrative-less structured briefing — so they cannot be satisfied by
 * echoing the stub.
 */

import type {
  HandlerOptions,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasOwnerAccess: vi.fn(async () => true),
}));

vi.mock("@elizaos/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@elizaos/agent")>()),
  hasOwnerAccess: mocks.hasOwnerAccess,
}));

import {
  __resetBriefComposersForTests,
  briefAction,
  setBriefComposers,
} from "../src/actions/brief.js";
import { LifeOpsRepository } from "../src/lifeops/repository.js";
import { createLifeOpsTestRuntime } from "./helpers/runtime.ts";

function makeRuntime(
  options: {
    useModel?: (modelType: string, args: { prompt: string }) => Promise<string>;
    reportError?: (
      scope: string,
      error: unknown,
      context?: Record<string, unknown>,
    ) => void;
  } = {},
): IAgentRuntime {
  return {
    agentId: "agent-brief-test" as UUID,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    useModel:
      options.useModel ?? (async () => "Composed narrative from the model."),
    // The J4 degrade in loadCompletedTodayFromService reports through the
    // diagnostic boundary; the harness runtime must carry it so the evening
    // composer can run without a LifeOpsService registered.
    reportError: options.reportError ?? (() => undefined),
  } as unknown as IAgentRuntime;
}

function makeMessage(text = "give me my brief"): Memory {
  return {
    id: "msg-brief-1" as UUID,
    entityId: "owner-1" as UUID,
    roomId: "room-brief-1" as UUID,
    content: { text },
  } as Memory;
}

async function callBrief(
  runtime: IAgentRuntime,
  message: Memory,
  parameters: Record<string, unknown>,
) {
  return briefAction.handler(
    runtime,
    message,
    undefined,
    { parameters } as unknown as HandlerOptions,
    async () => undefined,
  );
}

describe("BRIEF umbrella action — Daily Operations", () => {
  beforeEach(() => {
    __resetBriefComposersForTests();
    setBriefComposers({
      loadEngagementSummaries: async () => [],
      recordRenderedImpressions: async () => 0,
    });
    mocks.hasOwnerAccess.mockReset().mockResolvedValue(true);
  });

  describe("metadata", () => {
    it("validates as accessible for an owner-attached message", async () => {
      const ok = await briefAction.validate?.(
        makeRuntime(),
        makeMessage(),
        undefined,
      );
      expect(ok).toBe(true);
    });

    it("rejects calls with no subaction selector", async () => {
      const result = await callBrief(makeRuntime(), makeMessage(), {});
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "MISSING_SUBACTION" });
    });

    it("rejects callers that fail the owner-access check", async () => {
      mocks.hasOwnerAccess.mockResolvedValueOnce(false);
      const result = await callBrief(makeRuntime(), makeMessage(), {
        subaction: "compose_morning",
      });
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "PERMISSION_DENIED" });
    });
  });

  describe("compose_morning", () => {
    it("uses persisted ignored-item history to demote that class in the next brief", async () => {
      const runtimeResult = await createLifeOpsTestRuntime();
      try {
        await LifeOpsRepository.bootstrapSchema(runtimeResult.runtime);
        const repository = new LifeOpsRepository(runtimeResult.runtime);
        for (let day = 1; day <= 5; day += 1) {
          await repository.recordBriefItemEngagement({
            agentId: runtimeResult.runtime.agentId,
            briefingId: `brief-${day}`,
            itemId: "inbox:newsletter-1",
            source: "inbox",
            kind: "message",
            sourceId: "newsletter-1",
            itemClass: "inbox:newsletter-digest",
            eventType: "ignored",
            eventAt: new Date(
              Date.now() - day * 24 * 60 * 60 * 1_000,
            ).toISOString(),
            weight: -1,
            metadata: { scenario: "ignore-pattern" },
          });
        }

        // Restore the production engagement loader while keeping unrelated
        // source reads deterministic for this action-level database contract.
        __resetBriefComposersForTests();
        setBriefComposers({
          loadCalendar: async () => [],
          loadInbox: async () => [
            {
              id: "newsletter-1",
              channel: "gmail",
              senderName: "Weekly Digest",
              snippet: "Your weekly newsletter roundup",
              urgency: "low",
              classification: "unread",
            },
          ],
          loadLife: async () => [],
          loadMoney: async () => [],
          loadCompletedToday: async () => [],
        });

        const result = await callBrief(runtimeResult.runtime, makeMessage(), {
          subaction: "compose_morning",
          format: "json",
        });

        expect(result.success).toBe(true);
        const data = result.data as {
          briefing: {
            editorial: {
              demotedItemClasses: readonly string[];
              decisions: readonly {
                itemId: string;
                action: string;
                reason: string;
              }[];
            };
          };
        };
        expect(data.briefing.editorial.demotedItemClasses).toEqual([
          "inbox:newsletter-digest",
        ]);
        expect(data.briefing.editorial.decisions).toContainEqual({
          itemId: "inbox:newsletter-1",
          action: "demote",
          reason:
            "inbox:newsletter-digest has repeated ignore history with no acted-on signal",
        });
      } finally {
        await runtimeResult.cleanup();
      }
    });

    it("reports unavailable engagement history without blocking the structured brief", async () => {
      const reportError = vi.fn();
      __resetBriefComposersForTests();
      setBriefComposers({
        loadCalendar: async () => [],
        loadInbox: async () => [],
        loadLife: async () => [],
        loadMoney: async () => [],
        loadCompletedToday: async () => [],
      });

      const result = await callBrief(
        makeRuntime({ reportError }),
        makeMessage(),
        {
          subaction: "compose_morning",
          format: "json",
        },
      );

      expect(result.success).toBe(true);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        "Brief.loadEngagementSummaries",
        expect.anything(),
        { surface: "brief-editorial-engagement" },
      );
    });

    it("surfaces regret-audited ledger commitments as a briefing section (#14864)", async () => {
      setBriefComposers({
        loadCalendar: async () => [],
        loadInbox: async () => [],
        loadLife: async () => [],
        loadMoney: async () => [],
        loadCompletedToday: async () => [],
        loadCommitments: async () => [
          {
            id: "commit-1",
            kind: "commitment",
            summary: "I'll send the deck Friday",
            counterparty: "Dana",
            dueAt: "2026-08-14T17:00:00.000Z",
            status: "open",
            regretScore: 1.19,
            reasons: ["no scheduled tracker", "due within the regret horizon"],
          },
        ],
      });
      const result = await callBrief(makeRuntime(), makeMessage(), {
        subaction: "compose_morning",
        format: "json",
      });
      expect(result.success).toBe(true);
      const data = result.data as {
        briefing: {
          sections: {
            commitments?: readonly { id: string; regretScore: number }[];
          };
        };
      };
      expect(data.briefing.sections.commitments).toHaveLength(1);
      expect(data.briefing.sections.commitments?.[0]).toMatchObject({
        id: "commit-1",
        regretScore: 1.19,
      });
    });

    it("omits the commitments section when include.commitments is false", async () => {
      const loadCommitments = vi.fn(async () => [
        {
          id: "commit-1",
          kind: "commitment" as const,
          summary: "I'll send the deck Friday",
          counterparty: null,
          dueAt: null,
          status: "open" as const,
          regretScore: 1.0,
          reasons: ["no scheduled tracker"],
        },
      ]);
      setBriefComposers({
        loadCalendar: async () => [],
        loadInbox: async () => [],
        loadLife: async () => [],
        loadMoney: async () => [],
        loadCompletedToday: async () => [],
        loadCommitments,
      });
      const result = await callBrief(makeRuntime(), makeMessage(), {
        subaction: "compose_morning",
        format: "json",
        include: { commitments: false },
      });
      expect(result.success).toBe(true);
      const data = result.data as {
        briefing: { sections: { commitments?: unknown } };
      };
      expect(data.briefing.sections.commitments).toBeUndefined();
      expect(loadCommitments).not.toHaveBeenCalled();
    });

    it("feeds the loader payload to the model and returns the trimmed narrative", async () => {
      // Padded model reply: the pipeline must return the TRIMMED narrative,
      // so a straight echo of the stub cannot satisfy the assertion.
      const useModel = vi.fn(
        async () => "  Composed narrative from the model.\n",
      );
      const runtime = makeRuntime({ useModel });
      setBriefComposers({
        loadCalendar: async () => [
          {
            id: "evt-1",
            title: "Board sync",
            startAt: "2026-05-11T09:00:00.000Z",
            endAt: "2026-05-11T10:00:00.000Z",
          },
        ],
        loadInbox: async () => [
          {
            id: "msg-1",
            channel: "gmail",
            senderName: "Bob",
            snippet: "Approve the SOW",
            urgency: "high",
            classification: "needs_reply",
          },
        ],
        loadLife: async () => [
          {
            id: "todo-1",
            kind: "todo",
            title: "Send NDA",
            dueAt: "2026-05-11T17:00:00.000Z",
          },
        ],
        loadMoney: async () => [
          {
            id: "charge-1",
            merchant: "Netflix",
            amountUsd: 15.99,
            cadence: "monthly",
            nextChargeAt: "2026-05-20T00:00:00.000Z",
          },
        ],
      });

      const result = await callBrief(runtime, makeMessage(), {
        subaction: "compose_morning",
      });

      expect(result.success).toBe(true);
      const data = result.data as {
        subaction: string;
        briefing: {
          kind: string;
          period: string;
          sections: Record<string, unknown[]>;
          narrative?: string;
        };
      };
      expect(data.subaction).toBe("compose_morning");
      expect(data.briefing.kind).toBe("morning");
      expect(data.briefing.period).toBe("today");
      expect(data.briefing.sections.calendar).toHaveLength(1);
      expect(data.briefing.sections.inbox).toHaveLength(1);
      expect(data.briefing.sections.life).toHaveLength(1);
      expect(data.briefing.sections.money).toHaveLength(1);
      // Trimmed by the compose pass — not the raw model string.
      expect(data.briefing.narrative).toBe(
        "Composed narrative from the model.",
      );

      // The compose prompt must carry EVERY loader section the briefing
      // aggregated, plus the kind/period header — the model is narrating the
      // real payload, not free-associating.
      expect(useModel).toHaveBeenCalledTimes(1);
      const [modelType, args] = useModel.mock.calls[0] as [
        string,
        { prompt: string },
      ];
      expect(modelType).toBe(ModelType.TEXT_LARGE);
      expect(args.prompt).toContain("morning briefing for today");
      expect(args.prompt).toContain("Board sync"); // calendar
      expect(args.prompt).toContain("Approve the SOW"); // inbox
      expect(args.prompt).toContain("Send NDA"); // life
      expect(args.prompt).toContain("Netflix"); // money
      expect(args.prompt).toContain('"editorial"');
      expect(args.prompt).toContain('"itemId": "inbox:msg-1"');
      expect(args.prompt).toContain('"action": "lead"');
    });

    it("honors include flags by suppressing whole sections", async () => {
      setBriefComposers({
        loadCalendar: vi.fn(async () => []),
        loadInbox: vi.fn(async () => []),
        loadLife: vi.fn(async () => []),
        loadMoney: vi.fn(async () => []),
      });
      const result = await callBrief(makeRuntime(), makeMessage(), {
        subaction: "compose_morning",
        include: { calendar: true, inbox: false, life: false, money: false },
        format: "json",
      });
      expect(result.success).toBe(true);
      const data = result.data as {
        briefing: { sections: Record<string, unknown> };
      };
      expect(data.briefing.sections).toHaveProperty("calendar");
      expect(data.briefing.sections).not.toHaveProperty("inbox");
      expect(data.briefing.sections).not.toHaveProperty("life");
      expect(data.briefing.sections).not.toHaveProperty("money");
    });

    it("accepts simile-style action names mapped through the subaction map", async () => {
      const result = await callBrief(makeRuntime(), makeMessage(), {
        action: "WEEKLY_BRIEF",
      });
      expect(result.success).toBe(true);
      const data = result.data as {
        subaction: string;
        briefing: { period: string };
      };
      expect(data.subaction).toBe("compose_weekly");
      expect(data.briefing.period).toBe("this_week");
    });
  });

  describe("compose_evening", () => {
    it("uses the TEXT_LARGE model and skips compose pass in json format", async () => {
      const useModel = vi.fn(async () => "narrative text");
      const runtime = makeRuntime({ useModel });
      const result = await callBrief(runtime, makeMessage(), {
        subaction: "compose_evening",
        format: "json",
      });
      expect(result.success).toBe(true);
      expect(useModel).not.toHaveBeenCalled();
      const data = result.data as { briefing: { narrative?: string } };
      expect(data.briefing.narrative).toBeUndefined();
    });

    it("calls TEXT_LARGE with the structured payload in the prompt", async () => {
      const useModel = vi.fn(async () => "morning narrative");
      const runtime = makeRuntime({ useModel });
      setBriefComposers({
        loadCalendar: async () => [
          {
            id: "evt-7",
            title: "Standup",
            startAt: "2026-05-11T10:00:00.000Z",
            endAt: "2026-05-11T10:15:00.000Z",
          },
        ],
      });
      const result = await callBrief(runtime, makeMessage(), {
        subaction: "compose_morning",
      });
      expect(result.success).toBe(true);
      expect(useModel).toHaveBeenCalledTimes(1);
      const modelCall = useModel.mock.calls[0];
      expect(modelCall).toBeDefined();
      const [modelType, args] = modelCall as [string, { prompt: string }];
      expect(modelType).toBe(ModelType.TEXT_LARGE);
      expect(args.prompt).toContain("Standup");
    });
  });

  describe("compose_evening — completed-today wins (#16935)", () => {
    it("aggregates completedToday and feeds it to the narrative prompt", async () => {
      const useModel = vi.fn(async () => "evening narrative");
      const runtime = makeRuntime({ useModel });
      const loadCompletedToday = vi.fn(async () => [
        {
          id: "occ-done-1",
          kind: "todo" as const,
          title: "Sorted receipts",
          dueAt: null,
        },
      ]);
      setBriefComposers({
        loadLife: async () => [
          {
            id: "todo-open-1",
            kind: "todo" as const,
            title: "File the invoice",
            dueAt: null,
          },
        ],
        loadCompletedToday,
      });

      const result = await callBrief(runtime, makeMessage(), {
        subaction: "compose_evening",
      });
      expect(result.success).toBe(true);
      const data = result.data as {
        briefing: { sections: Record<string, unknown[]> };
      };
      expect(data.briefing.sections.completedToday).toEqual([
        expect.objectContaining({ title: "Sorted receipts" }),
      ]);
      // The narrative model sees the wins alongside the open items, and the
      // baseline instructions demand wins-first ordering for evening briefs.
      const [, args] = useModel.mock.calls[0] as [string, { prompt: string }];
      expect(args.prompt).toContain("Sorted receipts");
      expect(args.prompt).toContain("completedToday");
      expect(args.prompt).toContain("LEAD with those finished");
    });

    // Regression (#16966 post-merge review): the completed-today catch used
    // to degrade with a log-only warn — a broken load silently read as a
    // win-less day. The J4 degrade must surface through runtime.reportError
    // so RECENT_ERRORS and owner escalation see it.
    it("surfaces a failed completed-today load via reportError while the brief still composes", async () => {
      const reportError = vi.fn();
      // Default composers + a runtime with no LifeOpsService: the DEFAULT
      // loadCompletedTodayFromService path fails for real and must degrade
      // through its own J4 catch, not an injected stand-in.
      const runtime = makeRuntime({ reportError });
      const result = await callBrief(runtime, makeMessage(), {
        subaction: "compose_evening",
        include: { calendar: false, inbox: false, life: true, money: false },
        format: "json",
      });
      expect(result.success).toBe(true);
      const data = result.data as {
        briefing: { sections: Record<string, unknown> };
      };
      // The degrade omits the wins section entirely — a designed absence, not
      // a fabricated empty win list rendered as a healthy day.
      expect(data.briefing.sections).not.toHaveProperty("completedToday");
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        "Brief.loadCompletedToday",
        expect.anything(),
        { surface: "evening-brief-wins" },
      );
    });

    it("keeps morning briefs forward-looking (no completedToday load)", async () => {
      const useModel = vi.fn(async () => "morning narrative");
      const runtime = makeRuntime({ useModel });
      const loadCompletedToday = vi.fn(async () => []);
      setBriefComposers({ loadCompletedToday });
      const result = await callBrief(runtime, makeMessage(), {
        subaction: "compose_morning",
      });
      expect(result.success).toBe(true);
      expect(loadCompletedToday).not.toHaveBeenCalled();
      const data = result.data as {
        briefing: { sections: Record<string, unknown[]> };
      };
      expect(data.briefing.sections.completedToday).toBeUndefined();
    });
  });

  describe("narrative compose pass", () => {
    it("degrades to a narrative-less structured briefing when the model call throws", async () => {
      const useModel = vi.fn(async (): Promise<string> => {
        throw new Error("model unavailable");
      });
      const runtime = makeRuntime({ useModel });
      setBriefComposers({
        loadCalendar: async () => [
          {
            id: "evt-9",
            title: "Investor call",
            startAt: "2026-05-11T15:00:00.000Z",
            endAt: "2026-05-11T15:30:00.000Z",
          },
        ],
      });
      const result = await callBrief(runtime, makeMessage(), {
        subaction: "compose_morning",
      });
      expect(result.success).toBe(true);
      expect(useModel).toHaveBeenCalledTimes(1);
      const data = result.data as {
        briefing: { narrative?: string; sections: { calendar: unknown[] } };
      };
      // The structured briefing survives; only the narrative is dropped.
      expect(data.briefing.narrative).toBeUndefined();
      expect(data.briefing.sections.calendar).toHaveLength(1);
    });

    it("omits the narrative when the model returns a non-string payload", async () => {
      const useModel = vi.fn(
        async () => ({ not: "a string" }) as unknown as string,
      );
      const runtime = makeRuntime({ useModel });
      const result = await callBrief(runtime, makeMessage(), {
        subaction: "compose_morning",
      });
      expect(result.success).toBe(true);
      const data = result.data as { briefing: { narrative?: string } };
      expect(data.briefing.narrative).toBeUndefined();
    });

    it("omits the narrative when the model returns only whitespace", async () => {
      const useModel = vi.fn(async () => "   \n\t");
      const runtime = makeRuntime({ useModel });
      const result = await callBrief(runtime, makeMessage(), {
        subaction: "compose_morning",
      });
      expect(result.success).toBe(true);
      const data = result.data as { briefing: Record<string, unknown> };
      expect(data.briefing).not.toHaveProperty("narrative");
    });
  });

  describe("empty inputs", () => {
    it("still returns a structured briefing when every section is empty", async () => {
      const result = await callBrief(makeRuntime(), makeMessage(), {
        subaction: "compose_weekly",
        format: "json",
      });
      expect(result.success).toBe(true);
      const data = result.data as {
        briefing: { sections: { calendar: unknown[] } };
      };
      expect(data.briefing.sections.calendar).toHaveLength(0);
    });
  });
});
