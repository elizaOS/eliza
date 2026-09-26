/** Exercises progressive planner execution and truthful resource settlement with deterministic model and executor boundaries. */

import {
  type EffectReceipt,
  ElizaError,
  type PlannerRuntime,
  type PlannerTrajectory,
  type RecordedStage,
  runWithStreamingContext,
  type TrajectoryRecorder,
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
  reasoningTokens = 0,
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
          reasoningTokens,
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
  it("cancels a coding rate-limit wait without another inference", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const reason = new Error("caller cancelled during retry");
      const useModel = vi.fn().mockRejectedValue(
        Object.assign(new Error("rate limited"), {
          statusCode: 429,
          retryAfterMs: 60_000,
        }),
      );
      const turn = runWithStreamingContext(
        { onStreamChunk: async () => {}, abortSignal: controller.signal },
        () =>
          runPlannerLoop({
            context: { id: "cancel-rate-retry" },
            codingMode: true,
            runtime: { useModel },
            executeToolCall: async () => ({ success: true }),
          }),
      );
      const outcome = turn.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(10);
      controller.abort(reason);
      expect(await outcome).toEqual({ error: reason });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(useModel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps the existing coding deadline while waiting for a provider window", async () => {
    vi.stubEnv("ELIZA_CODING_PLANNER_CALL_TIMEOUT_MS", "1000");
    vi.useFakeTimers();
    try {
      const useModel = vi.fn().mockRejectedValue(
        Object.assign(new Error("rate limited"), {
          statusCode: 429,
          retryAfterMs: 60_000,
        }),
      );
      const turn = runPlannerLoop({
        context: { id: "deadline-rate-retry" },
        codingMode: true,
        runtime: { useModel },
        executeToolCall: async () => ({ success: true }),
      });
      await vi.advanceTimersByTimeAsync(1001);
      const result = await turn;
      expect(result.terminalFailure?.code).toBe("PLANNER_MODEL_CALL_TIMEOUT");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(useModel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it("waits for a coding rate-limit window without replaying settled tools", async () => {
    vi.useFakeTimers();
    try {
      const h = harness(2);
      const original = h.runtime.useModel;
      let calls = 0;
      const inputs: unknown[] = [];
      h.runtime.useModel = async (...args) => {
        calls++;
        inputs.push(args[1]);
        if (calls === 2)
          throw Object.assign(new Error("rate limited"), {
            statusCode: 429,
            responseHeaders: { "retry-after": "60" },
          });
        return original(...args);
      };
      const turn = runPlannerLoop({
        ...h,
        context: { id: "coding-rate-limit" },
        codingMode: true,
      });
      const settled = turn.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(59_999);
      expect(calls).toBe(2);
      expect(h.executed).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      const outcome = await settled;
      expect(outcome).not.toHaveProperty("error");
      if (!("result" in outcome)) throw outcome.error;
      expect(outcome.result.terminalFailure).toBeUndefined();
      expect(calls).toBe(3);
      expect(inputs[2]).toBe(inputs[1]);
      expect(h.executed).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([
    { codingMode: false, error: { statusCode: 429, retryAfterMs: 10 } },
    { codingMode: true, error: { statusCode: 429 } },
    {
      codingMode: true,
      error: { statusCode: 429, retryAfterMs: 3_000_000_000 },
    },
    {
      codingMode: true,
      error: { statusCode: 429, retryAfterMs: 10, code: "insufficient_quota" },
    },
    { codingMode: true, error: { statusCode: 500, retryAfterMs: 10 } },
  ])(
    "does not add retries outside a temporary coding rate-limit window: %j",
    async ({ codingMode, error }) => {
      const useModel = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("provider failure"), error));
      await runPlannerLoop({
        context: { id: "no-rate-retry" },
        codingMode,
        runtime: { useModel },
        executeToolCall: async () => ({ success: true }),
      }).catch(() => undefined);
      expect(useModel).toHaveBeenCalledTimes(1);
    },
  );
  it("bounds coding rate-limit retries at three inference attempts", async () => {
    vi.useFakeTimers();
    try {
      const useModel = vi.fn().mockRejectedValue(
        Object.assign(new Error("rate limited"), {
          statusCode: 429,
          retryAfterMs: 10,
        }),
      );
      const turn = runPlannerLoop({
        context: { id: "bounded-rate-retry" },
        codingMode: true,
        runtime: { useModel },
        executeToolCall: async () => ({ success: true }),
      }).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(100);
      await turn;
      expect(useModel).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves reported reasoning usage in recorded planner stages", async () => {
    const stages: RecordedStage[] = [];
    const recorder = {
      recordStage: async (_id: string, stage: RecordedStage) => {
        stages.push(stage);
      },
    } as unknown as TrajectoryRecorder;
    const h = harness(2, 100, "DISCOVER_ACTIONS", 7);
    await runPlannerLoop({
      ...h,
      context: { id: "reasoning-usage" },
      codingMode: true,
      recorder,
      trajectoryId: "reasoning-usage",
    });
    const plannerStages = stages.filter((stage) => stage.kind === "planner");
    expect(plannerStages).toHaveLength(2);
    expect(
      plannerStages.every((stage) => stage.model?.usage?.reasoningTokens === 7),
    ).toBe(true);
  });
  it.each([false, true])(
    "scopes the operator budget to coding turns (coding=%s)",
    async (codingMode) => {
      vi.stubEnv("ELIZA_CODING_MAX_PROMPT_TOKENS", "130");
      try {
        const h = harness(4, 60);
        const result = await runPlannerLoop({
          ...h,
          context: { id: "operator-budget" },
          codingMode,
        });
        expect(h.executed).toHaveLength(codingMode ? 2 : 4);
        expect(result.terminalFailure?.kind).toBe(
          codingMode ? "resource_limit" : undefined,
        );
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
  it("retains an explicit host budget ahead of the operator default", async () => {
    vi.stubEnv("ELIZA_CODING_MAX_PROMPT_TOKENS", "130");
    try {
      const h = harness(4, 60);
      const result = await runPlannerLoop({
        ...h,
        context: { id: "host-budget" },
        codingMode: true,
        config: { maxTrajectoryPromptTokens: 1000 },
      });
      expect(h.executed).toHaveLength(4);
      expect(result.terminalFailure).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("rejects an invalid coding budget before executing any model or tool", async () => {
    vi.stubEnv("ELIZA_CODING_MAX_PROMPT_TOKENS", "0");
    try {
      const h = harness(4, 60);
      await expect(
        runPlannerLoop({
          ...h,
          context: { id: "invalid-budget" },
          codingMode: true,
        }),
      ).rejects.toThrow("ELIZA_CODING_MAX_PROMPT_TOKENS");
      expect(h.rounds).toBe(0);
      expect(h.executed).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it.each([false, true])(
    "continues through discovery and more than sixteen domain calls with distinct recall queries (coding=%s)",
    async (codingMode) => {
      const h = harness(40);
      const modelCalls = vi.spyOn(h.runtime, "useModel");
      const result = await runPlannerLoop({
        ...h,
        context: { id: "long-work" },
        codingMode,
      });
      expect(h.executed).toHaveLength(40);
      if (codingMode)
        expect(modelCalls.mock.calls[0]?.[1]).toMatchObject({ stream: false });
      expect(modelCalls.mock.calls[0]?.[1]).toMatchObject({
        providerOptions: {
          eliza: {
            thinking: "off",
            ...(codingMode ? { preferToolReasoning: true } : {}),
          },
        },
      });
      if (!codingMode)
        expect(modelCalls.mock.calls[0]?.[1]).not.toHaveProperty(
          "providerOptions.eliza.preferToolReasoning",
        );
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

describe("coding verification recovery scope", () => {
  it.each<{
    label: string;
    retry: string;
    cwd: string;
    recovered: boolean;
    initialCwd?: string | null;
    firstActualCwd?: string;
    actualCwd?: string;
  }>([
    {
      label: "implicit then explicit directory with matching receipts",
      retry: "go test ./...",
      cwd: "/workspace",
      initialCwd: null,
      firstActualCwd: "/workspace",
      actualCwd: "/workspace",
      recovered: true,
    },
    {
      label: "identical arguments but different actual directories",
      retry: "go test ./...",
      cwd: "/workspace",
      firstActualCwd: "/workspace",
      actualCwd: "/other",
      recovered: false,
    },
    {
      label: "narrower suite with matching directory receipts",
      retry: "go test ./internal/config -run TestLoad",
      cwd: "/workspace",
      initialCwd: null,
      firstActualCwd: "/workspace",
      actualCwd: "/workspace",
      recovered: false,
    },
    {
      label: "same suite",
      retry: "go test ./...",
      cwd: "/workspace",
      recovered: true,
    },
    {
      label: "corrective prefix and same suite",
      retry: "go generate ./... && go test ./...",
      cwd: "/workspace",
      recovered: true,
    },
    {
      label: "narrower suite",
      retry: "go test ./internal/config -run TestLoad",
      cwd: "/workspace",
      recovered: false,
    },
    {
      label: "same suite in different workspace",
      retry: "go test ./...",
      cwd: "/other",
      recovered: false,
    },
  ])(
    "preserves evidence for $label",
    async ({
      retry,
      cwd,
      recovered,
      initialCwd,
      firstActualCwd,
      actualCwd,
    }) => {
      let round = 0;
      let calls = 0;
      const result = await runPlannerLoop({
        codingMode: true,
        context: { id: "verification-recovery" },
        runtime: {
          useModel: async () => {
            round++;
            if (round > 4) throw new Error("Unexpected planner retry");
            return {
              text: "",
              toolCalls: [
                {
                  id: `recovery-${round}`,
                  name: round < 3 ? "SHELL" : "REPLY",
                  arguments:
                    round < 3
                      ? {
                          command: round === 1 ? "go test ./..." : retry,
                          ...(round === 1 && initialCwd === null
                            ? {}
                            : {
                                cwd:
                                  round === 1
                                    ? (initialCwd ?? "/workspace")
                                    : cwd,
                              }),
                          eliza_turn_scope: "more_work_pending",
                        }
                      : {
                          text: "Verification completed.",
                          eliza_turn_scope: "final",
                        },
                },
              ],
            };
          },
        },
        executeToolCall: async () => {
          calls++;
          const success = calls !== 1;
          return {
            success,
            text: success ? "Tests passed" : "Tests failed",
            data: { cwd: calls === 1 ? firstActualCwd : actualCwd },
            verification: {
              kind: "test",
              family: "go",
              status: success ? "passed" : "failed",
              exitCode: success ? 0 : 1,
            },
          };
        },
      });
      expect(calls).toBe(2);
      expect(result.evaluator?.success).toBe(recovered);
      expect(result.terminalFailure?.kind).toBe(
        recovered ? undefined : "coding_tool_failure",
      );
      expect(
        result.trajectory.steps
          .filter((step) => step.result)
          .map((step) => step.result?.success),
      ).toEqual([false, true]);
    },
  );
});

describe("coding verification recovery guidance", () => {
  it("requests an unpiped verifier after a successful but uncertified command", async () => {
    let round = 0;
    const commands: string[] = [];
    const result = await runPlannerLoop({
      codingMode: true,
      context: { id: "piped-verification-recovery" },
      runtime: {
        useModel: async () => {
          round++;
          if (round > 5) throw new Error("Unexpected planner retry");
          const name =
            round === 1
              ? "WRITE"
              : round === 2 || round === 4
                ? "SHELL"
                : "REPLY";
          return {
            text: "",
            toolCalls: [
              {
                id: `verification-guidance-${round}`,
                name,
                arguments:
                  name === "SHELL"
                    ? {
                        command:
                          round === 2
                            ? "npx vitest run | tail -5"
                            : "npx vitest run",
                        eliza_turn_scope: "more_work_pending",
                      }
                    : {
                        text: "Done",
                        eliza_turn_scope:
                          name === "REPLY" ? "final" : "more_work_pending",
                      },
              },
            ],
          };
        },
      },
      executeToolCall: async (call) => {
        if (call.name === "WRITE")
          return { success: true, text: "File written" };
        const command = String(call.params?.command);
        commands.push(command);
        return {
          success: true,
          text: "Tests 14 passed",
          ...(command === "npx vitest run"
            ? {
                verification: {
                  kind: "test" as const,
                  status: "passed" as const,
                  family: "npx vitest",
                  exitCode: 0,
                },
              }
            : {}),
        };
      },
    });
    expect(commands).toEqual(["npx vitest run | tail -5", "npx vitest run"]);
    expect(result.evaluator?.success).toBe(true);
    const guidance = result.trajectory.evaluatorOutputs
      .map((output) => output.messageToUser ?? "")
      .join("\n");
    expect(guidance).toContain("without pipes");
    expect(guidance).toContain("standalone");
    expect(guidance).not.toContain("or diff check");
  });
});

describe("terminal coding model failures", () => {
  it.each([
    { code: "MODEL_OUTPUT_INCOMPLETE", kind: "provider_issue" },
    { code: "PROVIDER_CONTEXT_OVERFLOW", kind: "context_overflow" },
  ])(
    "preserves settled effects without retry after $code",
    async ({ code, kind }) => {
      let calls = 0;
      let effects = 0;
      const result = await runPlannerLoop({
        codingMode: true,
        context: { id: "incomplete-after-write" },
        runtime: {
          useModel: async () => {
            calls++;
            if (calls > 1)
              throw new ElizaError("Provider output stopped", {
                code,
                context: { finishReason: "length" },
              });
            return {
              text: "",
              toolCalls: [
                {
                  id: "write-before-incomplete",
                  name: "WRITE",
                  arguments: { eliza_turn_scope: "more_work_pending" },
                },
              ],
            };
          },
        },
        executeToolCall: async () => {
          effects++;
          return {
            success: true,
            text: "File written",
            effectReceipts: [receipt],
            data: { file: "changed.ts" },
          };
        },
      });
      expect(calls).toBe(2);
      expect(effects).toBe(1);
      expect(result.trajectory.steps[0]?.result?.effectReceipts).toEqual([
        receipt,
      ]);
      expect(result.trajectory.steps[0]?.result?.data?.file).toBe("changed.ts");
      expect(result.evaluator?.success).toBe(false);
      expect(result.terminalFailure).toMatchObject({
        code,
        kind,
        transient: false,
      });
      expect(result.finalMessage).toContain("incomplete");
    },
  );
  it.each([
    {
      codingMode: false,
      error: new ElizaError("Provider output stopped", {
        code: "MODEL_OUTPUT_INCOMPLETE",
      }),
    },
    { codingMode: true, error: new TypeError("Implementation bug") },
  ])(
    "does not swallow unrelated failures ($codingMode)",
    async ({ codingMode, error }) => {
      await expect(
        runPlannerLoop({
          codingMode,
          context: { id: "propagated-error" },
          runtime: {
            useModel: async () => {
              throw error;
            },
          },
          executeToolCall: async () => ({ success: true }),
        }),
      ).rejects.toBe(error);
    },
  );
});
