/**
 * `PRIORITIZE` umbrella action — unit tests (W2-5).
 *
 * Wave-1 scaffold. Asserts that the LLM ranking surface exists, dispatches
 * across the three subaction names, and recovers gracefully from model
 * failures or empty inputs.
 */

import type { HandlerOptions, IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasOwnerAccess: vi.fn(async () => true),
}));

vi.mock("@elizaos/agent", () => ({
  hasOwnerAccess: mocks.hasOwnerAccess,
}));

import {
  __resetPrioritizeLoadersForTests,
  prioritizeAction,
  setPrioritizeLoaders,
} from "../src/actions/prioritize.js";

function makeRuntime(options: {
  useModel?: (modelType: string, args: { prompt: string }) => Promise<string>;
} = {}): IAgentRuntime {
  return {
    agentId: "agent-prioritize-test" as UUID,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
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
      const [modelType] = useModel.mock.calls[0]!;
      expect(modelType).toBe(ModelType.TEXT_LARGE);
      const data = result.data as {
        ranked: { id: string; rank: number; score: number; reasoning: string }[];
      };
      expect(data.ranked).toHaveLength(2);
      expect(data.ranked[0]).toMatchObject({
        id: "todo-1",
        rank: 1,
        score: 0.95,
      });
      expect(data.ranked[1]).toMatchObject({ id: "todo-3", rank: 2 });
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
