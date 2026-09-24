/** Exercises progressive planner execution and truthful resource settlement with deterministic model and executor boundaries. */

import {
  type EffectReceipt,
  type PlannerRuntime,
  type PlannerTrajectory,
  runWithStreamingContext,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { runPlannerLoop } from "./planner-loop.ts";

const receipt: EffectReceipt = {
  receiptId: "saved-record-receipt",
  operation: "record.create",
  resource: { kind: "record", id: "saved-record", version: "1" },
  artifacts: [],
  idempotency: { key: "create-record", replayed: false },
  observedAt: "2026-09-24T00:00:00.000Z",
  outcome: "applied",
  commit: {
    kind: "durable",
    id: "saved-record",
    committedAt: "2026-09-24T00:00:00.000Z",
  },
};

function harness(
  total: number,
  promptTokens = 100,
  discoveryName = "DISCOVER_ACTIONS",
) {
  let rounds = 0;
  const executed: string[] = [];
  const runtime: PlannerRuntime = {
    useModel: async () => {
      rounds++;
      if (rounds > total + 2) throw new Error("Planner failed to settle");
      return {
        text: "",
        toolCalls: [
          {
            id: `call-${rounds}`,
            name: rounds % 2 ? discoveryName : "MEMORY_SEARCH",
            arguments: {
              query: `subject ${rounds}`,
              eliza_turn_scope: "more_work_pending",
            },
          },
        ],
        usage: {
          promptTokens,
          completionTokens: 1,
          totalTokens: promptTokens + 1,
        },
      };
    },
  };
  return {
    runtime,
    executed,
    get rounds() {
      return rounds;
    },
    executeToolCall: async (call: { name: string }) => {
      executed.push(call.name);
      return {
        success: true,
        transcriptVisibility: "internal" as const,
        data: {
          readOnlyOperation: true,
          count: 1,
          result: `evidence ${executed.length}`,
        },
        ...(executed.length === total
          ? { continueChain: false, text: "All requested evidence checked." }
          : {}),
      };
    },
  };
}

describe("long progressive planner trajectories", () => {
  it.each([false, true])(
    "continues through discovery and more than sixteen domain calls with distinct recall queries (coding=%s)",
    async (codingMode) => {
      const h = harness(40);
      const result = await runPlannerLoop({
        ...h,
        context: { id: "long-work" },
        codingMode,
      });
      expect(h.executed).toHaveLength(40);
      expect(
        h.executed.filter((name) => name === "MEMORY_SEARCH"),
      ).toHaveLength(20);
      expect(result.terminalFailure).toBeUndefined();
      expect(result.trajectory.steps).toHaveLength(40);
    },
  );

  it("honors an explicit coding domain cap without charging discovery or losing pending work", async () => {
    const h = harness(12);
    const result = await runPlannerLoop({
      ...h,
      context: { id: "limited" },
      codingMode: true,
      config: { maxToolCalls: 2 },
    });
    expect(h.executed.filter((name) => name === "MEMORY_SEARCH")).toHaveLength(
      2,
    );
    expect(
      h.executed.filter((name) => name === "DISCOVER_ACTIONS"),
    ).toHaveLength(3);
    expect(result.evaluator?.success).toBe(false);
    expect(result.terminalFailure?.code).toBe("PLANNER_RESOURCE_LIMIT");
    expect(result.trajectory.steps).toHaveLength(5);
    expect(result.trajectory.plannedQueue[0]?.name).toBe("MEMORY_SEARCH");
  });

  it("preserves settled evidence and stops before new execution at the token boundary", async () => {
    const h = harness(12, 60);
    const result = await runPlannerLoop({
      ...h,
      context: { id: "resource" },
      codingMode: true,
      config: { maxTrajectoryPromptTokens: 130 },
    });
    expect(h.executed).toHaveLength(2);
    expect(result.trajectory.steps).toHaveLength(2);
    expect(result.trajectory.steps[1]?.result?.data?.result).toBe("evidence 2");
    expect(result.evaluator?.success).toBe(false);
    expect(result.modelUsage?.modelCalls).toBe(3);
    expect(result.finalMessage).toContain("before the request was complete");
  });
  it("cancels after a settled operation without dispatching the next call", async () => {
    const h = harness(8);
    const controller = new AbortController();
    const stopped = new Error("Caller cancelled");
    let trajectory: PlannerTrajectory | undefined;
    const turn = runWithStreamingContext(
      { onStreamChunk: async () => {}, abortSignal: controller.signal },
      () =>
        runPlannerLoop({
          ...h,
          context: { id: "cancelled" },
          codingMode: true,
          runtime: {
            useModel: async () => ({
              text: "",
              toolCalls: [
                {
                  id: "save-before-cancel",
                  name: "SAVE_RECORD",
                  arguments: { eliza_turn_scope: "more_work_pending" },
                },
              ],
            }),
          },
          executeToolCall: async (call, execution) => {
            trajectory = execution.trajectory;
            await h.executeToolCall(call);
            controller.abort(stopped);
            return {
              success: true,
              effectReceipts: [receipt],
              data: { recordId: "saved-record" },
            };
          },
        }),
    );
    await expect(turn).rejects.toBe(stopped);
    expect(h.executed).toHaveLength(1);
    expect(trajectory?.steps).toHaveLength(1);
    expect(trajectory?.steps[0]?.result?.success).toBe(true);
    expect(trajectory?.steps[0]?.result?.effectReceipts).toEqual([receipt]);
  });
  it("preserves a committed result when the next coding model call times out", async () => {
    const previous = process.env.ELIZA_CODING_PLANNER_CALL_TIMEOUT_MS;
    process.env.ELIZA_CODING_PLANNER_CALL_TIMEOUT_MS = "1000";
    vi.useFakeTimers();
    let calls = 0;
    try {
      const turn = runPlannerLoop({
        context: { id: "timeout-after-write" },
        codingMode: true,
        runtime: {
          useModel: async () => {
            calls++;
            if (calls > 1) return new Promise<never>(() => {});
            return {
              text: "",
              toolCalls: [
                {
                  id: "write",
                  name: "WRITE",
                  arguments: { eliza_turn_scope: "more_work_pending" },
                },
              ],
            };
          },
        },
        executeToolCall: async () => ({
          success: true,
          text: "Record saved.",
          effectReceipts: [receipt],
          data: { recordId: "saved-record" },
        }),
      });
      await vi.advanceTimersByTimeAsync(1100);
      const result = await turn;
      expect(result.trajectory.steps).toHaveLength(1);
      expect(result.trajectory.steps[0]?.result?.data?.recordId).toBe(
        "saved-record",
      );
      expect(result.evaluator?.success).toBe(false);
      expect(result.terminalFailure?.code).toBe("PLANNER_MODEL_CALL_TIMEOUT");
      expect(result.trajectory.steps[0]?.result?.effectReceipts).toEqual([
        receipt,
      ]);
      expect(result.finalMessage).not.toContain("nothing was changed");
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
      if (previous === undefined)
        delete process.env.ELIZA_CODING_PLANNER_CALL_TIMEOUT_MS;
      else process.env.ELIZA_CODING_PLANNER_CALL_TIMEOUT_MS = previous;
    }
  });

  it("bounds repeated successful calls even without a default domain ceiling", async () => {
    let rounds = 0;
    let executions = 0;
    const result = await runPlannerLoop({
      context: { id: "no-progress" },
      codingMode: true,
      runtime: {
        useModel: async (_type, input) => {
          rounds++;
          if (rounds > 8) throw new Error("Unbounded repeated success");
          if (!input.tools)
            return {
              text: "The original result remains unchanged.",
              toolCalls: [],
            };
          return {
            text: "",
            toolCalls: [
              {
                id: `repeat-${rounds}`,
                name: "READ",
                arguments: {
                  id: "same",
                  eliza_turn_scope: "more_work_pending",
                },
              },
            ],
          };
        },
      },
      tools: [
        {
          name: "READ",
          description: "Read record",
          parameters: {
            type: "object",
            properties: { id: { type: "string" } },
          },
        },
      ],
      executeToolCall: async () => {
        executions++;
        return {
          success: true,
          text: "Original result",
          data: { readOnlyOperation: true },
        };
      },
    });
    expect(executions).toBe(4);
    expect(rounds).toBeLessThanOrEqual(6);
    expect(result.status).toBe("finished");
    expect(result.evaluator?.success).toBe(false);
    expect(result.finalMessage).toContain("unchanged results");
  });
  it("settles an explicit recall cap as incomplete with the next query retained", async () => {
    const h = harness(10);
    const result = await runPlannerLoop({
      ...h,
      context: { id: "recall-cap" },
      codingMode: true,
      config: { maxMemorySearchRounds: 2 },
    });
    expect(h.executed.filter((name) => name === "MEMORY_SEARCH")).toHaveLength(
      2,
    );
    expect(result.terminalFailure?.kind).toBe("resource_limit");
    expect(result.terminalFailure?.transient).toBe(false);
    expect(result.trajectory.plannedQueue[0]?.params?.query).toBe("subject 6");
  });
  it("allows repeated observations whose complete results change", async () => {
    let count = 0;
    const result = await runPlannerLoop({
      context: { id: "changing-observation" },
      codingMode: true,
      runtime: {
        useModel: async () => ({
          text: "",
          toolCalls: [
            {
              id: `poll-${count}`,
              name: "READ",
              arguments: { id: "job", eliza_turn_scope: "more_work_pending" },
            },
          ],
        }),
      },
      executeToolCall: async () => {
        count++;
        if (count > 20) throw new Error("Did not settle");
        return {
          success: true,
          data: { readOnlyOperation: true, progress: count },
          ...(count === 20
            ? { continueChain: false, text: "Job complete." }
            : {}),
        };
      },
    });
    expect(count).toBe(20);
    expect(result.terminalFailure).toBeUndefined();
  });
  it.each([false, true])(
    "keeps legacy discovery compatible and outside the domain budget (canonical schema=%s)",
    async (exposeCanonical) => {
      const h = harness(8, 100, "DISCOVER_TOOLS");
      const result = await runPlannerLoop({
        ...h,
        context: { id: "legacy-discovery" },
        codingMode: true,
        config: { maxToolCalls: 1 },
        ...(exposeCanonical
          ? {
              tools: ["DISCOVER_ACTIONS", "MEMORY_SEARCH"].map((name) => ({
                name,
                description: "Authorized operation",
                parameters: {
                  type: "object" as const,
                  properties: { query: { type: "string" as const } },
                },
              })),
            }
          : {}),
      });
      const discovery = exposeCanonical ? "DISCOVER_ACTIONS" : "DISCOVER_TOOLS";
      expect(h.executed).toEqual([discovery, "MEMORY_SEARCH", discovery]);
      expect(result.terminalFailure?.kind).toBe("resource_limit");
      expect(
        result.trajectory.steps.map((step) => step.toolCall?.name),
      ).toEqual(h.executed);
      expect(result.trajectory.plannedQueue[0]?.name).toBe("MEMORY_SEARCH");
    },
  );
});
