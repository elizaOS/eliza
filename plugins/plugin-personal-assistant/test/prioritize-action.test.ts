/**
 * `PRIORITIZE` umbrella action — unit tests (W2-5).
 *
 * Wave-1 scaffold. Asserts that the LLM ranking surface exists, dispatches
 * across the three subaction names, and recovers gracefully from model
 * failures or empty inputs.
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
  createWorkThreadStore: vi.fn(),
  createApprovalQueue: vi.fn(),
}));

vi.mock("@elizaos/agent", () => ({
  hasOwnerAccess: mocks.hasOwnerAccess,
}));

vi.mock("../src/lifeops/work-threads/index.js", () => ({
  createWorkThreadStore: mocks.createWorkThreadStore,
}));

vi.mock("../src/lifeops/approval-queue.js", () => ({
  createApprovalQueue: mocks.createApprovalQueue,
}));

import {
  __resetPrioritizeLoadersForTests,
  prioritizeAction,
  setPrioritizeLoaders,
} from "../src/actions/prioritize.js";

function makeRuntime(
  options: {
    useModel?: (modelType: string, args: { prompt: string }) => Promise<string>;
    services?: Record<string, unknown>;
  } = {},
): IAgentRuntime {
  const services = options.services ?? {};
  return {
    agentId: "agent-prioritize-test" as UUID,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    getService: (name: string) => services[name] ?? null,
    useModel:
      options.useModel ??
      (async () =>
        JSON.stringify({
          ranked: [
            { id: "todo-1", score: 0.9, reasoning: "due today" },
            { id: "todo-2", score: 0.4, reasoning: "later" },
          ],
        })),
  } as unknown as IAgentRuntime;
}

function makeMessage(text = "what should I focus on?"): Memory {
  return {
    id: "msg-prioritize-1" as UUID,
    entityId: "owner-1" as UUID,
    roomId: "room-prioritize-1" as UUID,
    content: { text },
  } as Memory;
}

async function callPrioritize(
  runtime: IAgentRuntime,
  message: Memory,
  parameters: Record<string, unknown>,
) {
  return prioritizeAction.handler(
    runtime,
    message,
    undefined,
    { parameters } as unknown as HandlerOptions,
    async () => undefined,
  );
}

describe("PRIORITIZE umbrella action — focus ranking", () => {
  beforeEach(() => {
    __resetPrioritizeLoadersForTests();
    mocks.hasOwnerAccess.mockReset().mockResolvedValue(true);
    mocks.createWorkThreadStore.mockReset().mockReturnValue({
      list: vi.fn(async () => []),
    });
    mocks.createApprovalQueue.mockReset().mockReturnValue({
      list: vi.fn(async () => []),
    });
  });

  describe("metadata", () => {
    it("exposes the canonical name and PRD similes", () => {
      expect(prioritizeAction.name).toBe("PRIORITIZE");
      const similes = prioritizeAction.similes ?? [];
      for (const required of [
        "PRIORITIZE",
        "RANK_TODAY",
        "WHAT_MATTERS_MOST",
        "PRIORITIZE_TODAY",
      ]) {
        expect(similes).toContain(required);
      }
    });

    it("rejects calls with no subject or subaction", async () => {
      const result = await callPrioritize(makeRuntime(), makeMessage(), {});
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "MISSING_SUBACTION" });
    });

    it("rejects callers that fail the owner-access check", async () => {
      mocks.hasOwnerAccess.mockResolvedValueOnce(false);
      const result = await callPrioritize(makeRuntime(), makeMessage(), {
        subaction: "rank_todos",
      });
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "PERMISSION_DENIED" });
    });

    it("accepts the `subject` alias and maps it onto the subaction", async () => {
      setPrioritizeLoaders({
        loadThreads: async () => [
          { id: "thread-1", title: "Vendor follow-up" },
        ],
      });
      const useModel = vi.fn(async () =>
        JSON.stringify({
          ranked: [{ id: "thread-1", score: 0.7, reasoning: "two weeks idle" }],
        }),
      );
      const result = await callPrioritize(
        makeRuntime({ useModel }),
        makeMessage(),
        { subject: "threads" },
      );
      expect(result.success).toBe(true);
      const data = result.data as { subaction: string; subject: string };
      expect(data.subaction).toBe("rank_threads");
      expect(data.subject).toBe("threads");
    });
  });

  describe("rank_todos", () => {
    it("returns a ranked list driven by the model output", async () => {
      setPrioritizeLoaders({
        loadTodos: async () => [
          { id: "todo-1", title: "Send NDA" },
          { id: "todo-2", title: "Read papers" },
          { id: "todo-3", title: "Cancel gym" },
        ],
      });
      const useModel = vi.fn(async () =>
        JSON.stringify({
          ranked: [
            { id: "todo-1", score: 0.95, reasoning: "due today" },
            { id: "todo-3", score: 0.3, reasoning: "small chore" },
          ],
        }),
      );
      const result = await callPrioritize(
        makeRuntime({ useModel }),
        makeMessage(),
        { subaction: "rank_todos", topN: 5 },
      );
      expect(result.success).toBe(true);
      expect(useModel).toHaveBeenCalledTimes(1);
      expect(useModel.mock.calls[0]?.[0]).toBe(ModelType.TEXT_LARGE);
      const data = result.data as {
        ranked: {
          id: string;
          rank: number;
          score: number;
          reasoning: string;
        }[];
      };
      expect(data.ranked).toHaveLength(2);
      expect(data.ranked[0]).toMatchObject({
        id: "todo-1",
        rank: 1,
        score: 0.95,
      });
      expect(data.ranked[1]).toMatchObject({ id: "todo-3", rank: 2 });
    });

    it("loads pending todos from the registered production service", async () => {
      const listTodos = vi.fn(async () => [
        {
          id: "todo-prod-1",
          content: "Send partner proposal",
          activeForm: "Sending partner proposal",
          status: "pending",
          metadata: {
            dueAt: "2026-07-01T09:00:00.000Z",
            priority: 1,
          },
          createdAt: new Date("2026-06-29T08:00:00.000Z"),
          updatedAt: new Date("2026-06-29T08:30:00.000Z"),
        },
      ]);
      const useModel = vi.fn(async (_modelType, args) => {
        expect(args.prompt).toContain("Sending partner proposal");
        return JSON.stringify({
          ranked: [
            {
              id: "todo-prod-1",
              score: 0.88,
              reasoning: "near deadline",
            },
          ],
        });
      });
      const runtime = makeRuntime({
        useModel,
        services: {
          todos: { list: listTodos },
        },
      });
      const result = await callPrioritize(runtime, makeMessage(), {
        subaction: "rank_todos",
      });
      expect(result.success).toBe(true);
      expect(listTodos).toHaveBeenCalledWith({
        entityId: "owner-1",
        agentId: "agent-prioritize-test",
        status: ["pending", "in_progress"],
        includeCompleted: false,
        limit: 50,
      });
      const data = result.data as {
        ranked: { id: string; title: string; dueAt?: string | null }[];
      };
      expect(data.ranked[0]).toMatchObject({
        id: "todo-prod-1",
        title: "Sending partner proposal",
        dueAt: "2026-07-01T09:00:00.000Z",
      });
    });

    it("respects topN by truncating the model's ranked list", async () => {
      setPrioritizeLoaders({
        loadTodos: async () => [
          { id: "todo-1", title: "A" },
          { id: "todo-2", title: "B" },
          { id: "todo-3", title: "C" },
        ],
      });
      const useModel = vi.fn(async () =>
        JSON.stringify({
          ranked: [
            { id: "todo-1", score: 0.9, reasoning: "" },
            { id: "todo-2", score: 0.5, reasoning: "" },
            { id: "todo-3", score: 0.3, reasoning: "" },
          ],
        }),
      );
      const result = await callPrioritize(
        makeRuntime({ useModel }),
        makeMessage(),
        { subaction: "rank_todos", topN: 2 },
      );
      expect(result.success).toBe(true);
      const data = result.data as { ranked: unknown[] };
      expect(data.ranked).toHaveLength(2);
    });

    it("returns an empty result when there are no todos to rank", async () => {
      const useModel = vi.fn();
      const result = await callPrioritize(
        makeRuntime({ useModel: useModel as never }),
        makeMessage(),
        { subaction: "rank_todos" },
      );
      expect(result.success).toBe(true);
      const data = result.data as { ranked: unknown[] };
      expect(data.ranked).toHaveLength(0);
      expect(useModel).not.toHaveBeenCalled();
    });
  });

  describe("rank_decisions", () => {
    it("loads pending approvals from the production queue by owner", async () => {
      const listApprovals = vi.fn(async () => [
        {
          id: "approve-prod-1",
          createdAt: new Date("2026-06-29T08:00:00.000Z"),
          updatedAt: new Date("2026-06-29T08:00:00.000Z"),
          state: "pending",
          requestedBy: "PERSONAL_ASSISTANT",
          subjectUserId: "owner-1",
          action: "send_email",
          payload: {
            action: "send_email",
            to: ["partner@example.com"],
            cc: [],
            bcc: [],
            subject: "NDA follow-up",
            body: "Following up.",
            threadId: null,
          },
          channel: "email",
          reason: "Owner must approve outbound NDA follow-up.",
          expiresAt: new Date("2026-06-29T18:00:00.000Z"),
          resolvedAt: null,
          resolvedBy: null,
          resolutionReason: null,
        },
      ]);
      mocks.createApprovalQueue.mockReturnValue({ list: listApprovals });
      const useModel = vi.fn(async () =>
        JSON.stringify({
          ranked: [
            {
              id: "approve-prod-1",
              score: 0.93,
              reasoning: "blocks partner",
            },
          ],
        }),
      );
      const runtime = makeRuntime({ useModel });
      const result = await callPrioritize(runtime, makeMessage(), {
        subaction: "rank_decisions",
      });
      expect(result.success).toBe(true);
      expect(mocks.createApprovalQueue).toHaveBeenCalledWith(runtime, {
        agentId: "agent-prioritize-test",
      });
      expect(listApprovals).toHaveBeenCalledWith({
        subjectUserId: "owner-1",
        state: "pending",
        action: null,
        limit: 50,
      });
      const data = result.data as {
        ranked: { id: string; title: string; dueAt?: string | null }[];
      };
      expect(data.ranked[0]).toMatchObject({
        id: "approve-prod-1",
        title: "Send email: NDA follow-up",
        dueAt: "2026-06-29T18:00:00.000Z",
      });
    });

    it("calls the decisions loader and returns ranking from the model", async () => {
      setPrioritizeLoaders({
        loadDecisions: async () => [
          { id: "approve-1", title: "Send NDA reply" },
        ],
      });
      const useModel = vi.fn(async () =>
        JSON.stringify({
          ranked: [
            { id: "approve-1", score: 1.0, reasoning: "blocking partner" },
          ],
        }),
      );
      const result = await callPrioritize(
        makeRuntime({ useModel }),
        makeMessage(),
        { subaction: "rank_decisions" },
      );
      expect(result.success).toBe(true);
      const data = result.data as {
        subaction: string;
        ranked: { id: string }[];
      };
      expect(data.subaction).toBe("rank_decisions");
      expect(data.ranked[0]?.id).toBe("approve-1");
    });
  });

  describe("rank_threads", () => {
    it("loads open owner work threads from the production store", async () => {
      const listThreads = vi.fn(async () => [
        {
          id: "thread-prod-1",
          agentId: "agent-prioritize-test",
          ownerEntityId: "owner-1",
          status: "waiting",
          title: "Vendor contract thread",
          summary: "Waiting on vendor contract redlines.",
          currentPlanSummary: "Review vendor redlines before replying.",
          primarySourceRef: {
            connector: "gmail",
            channelName: "Inbox",
            canRead: true,
            canMutate: true,
          },
          sourceRefs: [],
          participantEntityIds: ["owner-1"],
          currentScheduledTaskId: null,
          workflowRunId: null,
          approvalId: null,
          lastMessageMemoryId: "msg-1",
          version: 1,
          createdAt: "2026-06-29T07:00:00.000Z",
          updatedAt: "2026-06-29T08:00:00.000Z",
          lastActivityAt: "2026-06-29T08:00:00.000Z",
          metadata: {},
        },
      ]);
      mocks.createWorkThreadStore.mockReturnValue({ list: listThreads });
      const useModel = vi.fn(async () =>
        JSON.stringify({
          ranked: [
            {
              id: "thread-prod-1",
              score: 0.76,
              reasoning: "needs reply",
            },
          ],
        }),
      );
      const runtime = makeRuntime({ useModel });
      const result = await callPrioritize(runtime, makeMessage(), {
        subaction: "rank_threads",
      });
      expect(result.success).toBe(true);
      expect(mocks.createWorkThreadStore).toHaveBeenCalledWith(runtime);
      expect(listThreads).toHaveBeenCalledWith({
        statuses: ["active", "waiting", "paused"],
        ownerEntityId: "owner-1",
        limit: 50,
      });
      const data = result.data as {
        ranked: { id: string; title: string; summary?: string }[];
      };
      expect(data.ranked[0]).toMatchObject({
        id: "thread-prod-1",
        title: "Vendor contract thread",
        summary: "Review vendor redlines before replying.",
      });
    });
  });

  describe("model error handling", () => {
    it("surfaces MODEL_CALL_FAILED when useModel throws", async () => {
      setPrioritizeLoaders({
        loadTodos: async () => [{ id: "todo-1", title: "X" }],
      });
      const useModel = vi.fn(async () => {
        throw new Error("upstream timeout");
      });
      const result = await callPrioritize(
        makeRuntime({ useModel: useModel as never }),
        makeMessage(),
        { subaction: "rank_todos" },
      );
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({
        error: "MODEL_CALL_FAILED",
      });
    });

    it("returns input-order ranking when runtime.useModel is unavailable", async () => {
      setPrioritizeLoaders({
        loadTodos: async () => [
          { id: "todo-1", title: "A" },
          { id: "todo-2", title: "B" },
        ],
      });
      const runtime = {
        agentId: "agent-no-model" as UUID,
        logger: {
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
          debug: () => undefined,
        },
      } as unknown as IAgentRuntime;
      const result = await callPrioritize(runtime, makeMessage(), {
        subaction: "rank_todos",
      });
      expect(result.success).toBe(true);
      const data = result.data as {
        ranked: { id: string }[];
        warning?: string;
      };
      expect(data.warning).toBe("MODEL_UNAVAILABLE");
      expect(data.ranked.map((r) => r.id)).toEqual(["todo-1", "todo-2"]);
    });

    it("flags EMPTY_RANKING when the model output cannot be parsed", async () => {
      setPrioritizeLoaders({
        loadTodos: async () => [{ id: "todo-1", title: "A" }],
      });
      const useModel = vi.fn(async () => "this is not JSON at all");
      const result = await callPrioritize(
        makeRuntime({ useModel }),
        makeMessage(),
        { subaction: "rank_todos" },
      );
      expect(result.success).toBe(true);
      const data = result.data as { ranked: unknown[]; warning?: string };
      expect(data.ranked).toHaveLength(0);
      expect(data.warning).toBe("EMPTY_RANKING");
    });
  });
});
