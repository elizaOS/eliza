/** Exercises progressive planner execution and truthful resource settlement with deterministic model and executor boundaries. */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EffectReceipt,
  ElizaError,
  type PlannerRuntime,
  type PlannerToolResult,
  type PlannerTrajectory,
  PROVIDER_CONTEXT_OVERFLOW,
  type RecordedStage,
  runWithStreamingContext,
  type TrajectoryRecorder,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { runEvaluator } from "./evaluator.ts";
import {
  partitionRedundantSucceededCalls,
  runPlannerLoop,
} from "./planner-loop.ts";

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
  it("skips an identical settled write while permitting an evidenced corrective write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "corrective-write-"));
    const path = join(directory, "literal.txt");
    const requested = "An exact literal.  \n";
    const initial = requested.slice(0, -1);
    let plans = 0;
    let reads = 0;
    const writes: string[] = [];
    const receipts: EffectReceipt[] = [];
    const feedback: string[] = [];
    try {
      const result = await runPlannerLoop({
        codingMode: false,
        context: {
          id: "corrective-write",
          events: [
            {
              id: "handler",
              type: "message_handler",
              content: `Save this exact text including its final newline, then read it back:\n${requested}`,
              metadata: {
                plan: {
                  intents: [
                    "save the exact literal",
                    "read back the saved literal",
                  ],
                },
              },
            },
          ],
        },
        runtime: {
          useModel: async (_type, input) => {
            plans++;
            if (plans > 5)
              throw new Error("Planner failed to settle corrected work");
            if (plans === 4) {
              expect(writes).toEqual([initial]);
              const messages = JSON.stringify(input.messages);
              feedback.push(messages);
              expect(messages).toContain(
                "different currently authorized operation or arguments",
              );
              expect(messages).not.toContain(
                "Answer the user now from the results already gathered",
              );
            }
            const reading = plans === 2 || plans === 5;
            return {
              text: "",
              toolCalls: [
                {
                  id: `correction-${plans}`,
                  name: reading ? "READ" : "WRITE",
                  arguments: {
                    path,
                    ...(!reading
                      ? { content: plans === 4 ? requested : initial }
                      : {}),
                    eliza_turn_scope: reading ? "final" : "more_work_pending",
                  },
                },
              ],
            };
          },
        },
        executeToolCall: async (call) => {
          if (call.name === "WRITE") {
            const content = call.params.content;
            if (typeof content !== "string")
              throw new Error("Expected literal write content");
            writes.push(content);
            await writeFile(path, content);
            const bytes = await readFile(path);
            const applied: EffectReceipt = {
              ...receipt,
              receiptId: `corrective-write-${writes.length}`,
              operation: "file.write",
              resource: {
                kind: "file",
                id: path,
                version: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
              },
            };
            receipts.push(applied);
            return {
              success: true,
              userFacingText: "Written.",
              effectReceipts: [applied],
            };
          }
          reads++;
          return {
            success: true,
            text: await readFile(path, "utf8"),
            data: { readOnlyOperation: true },
          };
        },
        evaluate: async ({ trajectory }) => {
          const latest = trajectory.steps.at(-1);
          if (latest?.toolCall?.name === "WRITE") {
            expect(writes).toEqual(
              plans === 1 ? [initial] : [initial, requested],
            );
            expect(reads).toBe(plans === 1 ? 0 : 1);
            expect(latest.result?.effectReceipts).toEqual([receipts.at(-1)]);
            return {
              decision: "CONTINUE",
              success: false,
              thought:
                "The corrective write committed; read it back before completing.",
            };
          }
          const observed = latest?.result?.text;
          expect(observed).toBe(reads === 1 ? initial : requested);
          if (reads === 1)
            return {
              decision: "CONTINUE",
              success: false,
              thought:
                "The committed value lacks the requested final newline; correct it and verify.",
            };
          return {
            decision: "FINISH",
            success: true,
            thought: "The corrected content was read back exactly.",
            messageToUser: "Saved and verified the exact requested text.",
            replyEffectStatus: "applied",
            effectReceiptIds: [receipts[1].receiptId],
          };
        },
      });
      expect(plans).toBe(5);
      expect(writes).toEqual([initial, requested]);
      expect(reads).toBe(2);
      expect(feedback).toHaveLength(1);
      expect(await readFile(path, "utf8")).toBe(requested);
      expect(result.evaluator?.success).toBe(true);
      expect(result.finalMessage).toBe(
        "Saved and verified the exact requested text.",
      );
      expect(
        result.trajectory.steps.flatMap(
          (step) => step.result?.effectReceipts ?? [],
        ),
      ).toEqual(receipts);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each([false, true])(
    "replans a committed pending write without evaluation and preserves final verification (already complete=%s)",
    async (alreadyComplete) => {
      const directory = await mkdtemp(join(tmpdir(), "pending-commit-"));
      const path = join(directory, "result.txt");
      const content = "Complete original output";
      let plans = 0;
      let writes = 0;
      let reads = 0;
      const evaluate = vi.fn(async () => ({
        decision: "FINISH" as const,
        success: true,
        thought: "Final evidence and answer verified.",
        messageToUser: `Saved contents: ${content}`,
        replyEffectStatus: "applied" as const,
        effectReceiptIds: [receipt.receiptId],
      }));
      try {
        const result = await runPlannerLoop({
          codingMode: false,
          context: {
            id: "pending-committed-write",
            events: [
              {
                id: "handler",
                type: "message_handler",
                metadata: {
                  plan: {
                    intents: alreadyComplete
                      ? ["write the file"]
                      : ["write the file", "read and report exact contents"],
                  },
                },
              },
            ],
          },
          runtime: {
            useModel: async () => {
              plans++;
              if (plans > 2) throw new Error("Unexpected extra work");
              expect(evaluate).not.toHaveBeenCalled();
              return {
                text: "",
                toolCalls: [
                  {
                    id: `step-${plans}`,
                    name:
                      plans === 1
                        ? "WRITE"
                        : alreadyComplete
                          ? "REPLY"
                          : "READ",
                    arguments: {
                      ...(plans === 2 && alreadyComplete
                        ? { text: `Saved contents: ${content}` }
                        : {}),
                      eliza_turn_scope:
                        plans === 1 ? "more_work_pending" : "final",
                    },
                  },
                ],
              };
            },
          },
          executeToolCall: async (call) => {
            if (call.name === "WRITE") {
              writes++;
              await writeFile(path, content);
              return {
                success: true,
                verifiedUserFacing: true,
                turnComplete: true,
                userFacingText: "Written.",
                effectReceipts: [receipt],
                userFacingEffectReceiptIds: [receipt.receiptId],
              };
            }
            reads++;
            return { success: true, text: await readFile(path, "utf8") };
          },
          evaluate,
        });
        expect(writes).toBe(1);
        expect(reads).toBe(alreadyComplete ? 0 : 1);
        expect(plans).toBe(2);
        expect(evaluate).toHaveBeenCalledTimes(1);
        expect(result.finalMessage).toContain(content);
        expect(await readFile(path, "utf8")).toBe(content);
        expect(result.trajectory.evaluatorOutputs[0]?.thought).toContain(
          "without repeating the effect",
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
  it.each([
    "preview",
    "noop",
    "rollback",
    "failed",
    "evaluation-required",
    "awaiting-input",
    "confirmation",
    "wrapped-awaiting-input",
    "wrapped-confirmation",
    "final-scope",
    "undefined-scope",
    "failure-provenance",
    "read-receipt",
    "prior-rollback",
    "reply-failure",
  ])(
    "retains evaluation at the pending mutation boundary for %s",
    async (kind) => {
      const resultReceipt: EffectReceipt =
        kind === "preview"
          ? { ...receipt, outcome: "preview" }
          : kind === "noop"
            ? { ...receipt, outcome: "noop" }
            : kind === "rollback"
              ? {
                  ...receipt,
                  outcome: "rolled_back",
                  rollback: {
                    receiptId: "undo",
                    revertedReceiptIds: [receipt.receiptId],
                    rolledBackAt: receipt.observedAt,
                  },
                }
              : kind === "read-receipt"
                ? { ...receipt, operation: "record.read" }
                : receipt;
      const evaluate = vi.fn(async () => ({
        decision: "FINISH" as const,
        success: false,
        thought: "Settled without advancing the effect.",
        messageToUser: "The requested work remains incomplete.",
      }));
      const useModel = vi.fn(async () => ({
        text: "",
        toolCalls: [
          {
            id: "write",
            name: "WRITE",
            arguments:
              kind === "undefined-scope"
                ? {}
                : {
                    eliza_turn_scope:
                      kind === "final-scope" ? "final" : "more_work_pending",
                  },
          },
        ],
      }));
      const result = await runPlannerLoop({
        codingMode: false,
        context: { id: `guard-${kind}` },
        runtime: { useModel },
        ...(kind === "prior-rollback"
          ? {
              resumeState: {
                trajectory: {
                  context: { id: "earlier-rollback" },
                  steps: [],
                  archivedSteps: [
                    {
                      toolCall: { id: "undo", name: "UNDO", params: {} },
                      result: {
                        success: true,
                        effectReceipts: [
                          {
                            ...receipt,
                            receiptId: "undo-receipt",
                            outcome: "rolled_back" as const,
                            rollback: {
                              receiptId: "undo-commit",
                              revertedReceiptIds: [receipt.receiptId],
                              rolledBackAt: receipt.observedAt,
                            },
                          },
                        ],
                      },
                    },
                  ],
                  plannedQueue: [],
                  evaluatorOutputs: [],
                },
                modelUsage: {
                  promptTokens: 0,
                  completionTokens: 0,
                  modelCalls: 0,
                },
              },
            }
          : {}),
        evaluate,
        executeToolCall: async (): Promise<PlannerToolResult> => ({
          success: kind !== "failed",
          transcriptVisibility: "internal",
          turnComplete: kind === "evaluation-required" ? false : undefined,
          effectReceipts: [resultReceipt],
          ...(kind === "reply-failure"
            ? {
                replyFailure: {
                  kind: "reply_generation_error" as const,
                  code: "DELIVERY_FAILED",
                  message: "Reply failed after commit.",
                  transient: false as const,
                },
              }
            : {}),
          ...(kind === "awaiting-input"
            ? { data: { awaitingUserInput: true } }
            : {}),
          ...(kind === "confirmation"
            ? { data: { requiresConfirmation: true } }
            : {}),
          ...(kind === "wrapped-awaiting-input"
            ? { data: { values: { awaitingUserInput: true } } }
            : {}),
          ...(kind === "wrapped-confirmation"
            ? { data: { values: { requiresConfirmation: true } } }
            : {}),
          ...(kind === "failure-provenance"
            ? {
                failureProvenance: {
                  kind: "handler_error",
                  boundary: "handler",
                  code: "POST_COMMIT_BOOKKEEPING",
                  retryable: false,
                },
              }
            : {}),
        }),
      });
      expect(useModel).toHaveBeenCalledTimes(1);
      expect(evaluate).toHaveBeenCalledTimes(kind === "reply-failure" ? 0 : 1);
      if (kind === "reply-failure")
        expect(result.terminalFailure?.code).toBe("DELIVERY_FAILED");
    },
  );

  it("retains a single verified action-owned reply after evaluator protocol failure", async () => {
    const result = await runPlannerLoop({
      context: {
        id: "single-protocol-relay",
        events: [
          {
            id: "handler",
            type: "message_handler",
            metadata: { plan: { intents: ["create the record"] } },
          },
        ],
      },
      runtime: {
        useModel: async () => ({
          text: "",
          toolCalls: [
            {
              id: "create",
              name: "CREATE",
              arguments: { eliza_turn_scope: "final" },
            },
          ],
        }),
      },
      executeToolCall: async () => ({
        success: true,
        userFacingText: "Created the record.",
        turnComplete: true,
        verifiedUserFacing: true,
        effectReceipts: [receipt],
        userFacingEffectReceiptIds: [receipt.receiptId],
      }),
      evaluate: async () => ({
        success: false,
        decision: "CONTINUE",
        thought: "Malformed provider output.",
        protocolFailure: true,
      }),
    });
    expect(result.finalMessage).toBe("Created the record.");
    expect(result.trajectory.steps.filter((step) => step.result)).toHaveLength(
      1,
    );
  });

  it("composes readback after a clipboard-only malformed evaluator without replaying the write", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "planner-protocol-readback-"),
    );
    const path = join(directory, "index.html");
    const content = "<html><body>exact readback</body></html>";
    let writes = 0;
    let reads = 0;
    let plans = 0;
    let evaluations = 0;
    try {
      const result = await runPlannerLoop({
        codingMode: false,
        context: {
          id: "protocol-readback",
          events: [
            {
              id: "handler",
              type: "message_handler",
              metadata: {
                plan: {
                  intents: ["write the file", "read and report exact contents"],
                },
              },
            },
          ],
        },
        runtime: {
          useModel: async () => {
            if (++plans > 2) throw new Error("Repeated completed work");
            return {
              text: "",
              toolCalls:
                plans === 1
                  ? [
                      {
                        id: "write",
                        name: "FILE",
                        arguments: {
                          action: "write",
                          eliza_turn_scope: "final",
                        },
                      },
                      {
                        id: "read",
                        name: "FILE",
                        arguments: {
                          action: "read",
                          eliza_turn_scope: "final",
                        },
                      },
                    ]
                  : [
                      {
                        id: "reply",
                        name: "REPLY",
                        arguments: {
                          text: `Saved contents: ${content}`,
                          eliza_turn_scope: "final",
                        },
                      },
                    ],
            };
          },
        },
        executeToolCall: async (call) => {
          if (call.params?.action === "write") {
            writes++;
            await writeFile(path, content);
            return {
              success: true,
              text: "Wrote the file.",
              userFacingText: "Wrote the file.",
              verifiedUserFacing: true,
              turnComplete: true,
              effectReceipts: [receipt],
              userFacingEffectReceiptIds: [receipt.receiptId],
            };
          }
          reads++;
          return { success: true, text: await readFile(path, "utf8") };
        },
        evaluate: async ({ context, trajectory }) =>
          runEvaluator({
            context,
            trajectory,
            effects: { copyToClipboard: false },
            runtime: {
              useModel: async () =>
                JSON.stringify(
                  ++evaluations === 1
                    ? {
                        thought: "Write and read succeeded.",
                        success: true,
                        decision: "FINISH",
                        replyEffectStatus: "applied",
                        effectReceiptIds: [receipt.receiptId],
                        copyToClipboard: { title: "contents", content },
                      }
                    : {
                        thought: "The final reply reports the saved contents.",
                        success: true,
                        decision: "FINISH",
                        messageToUser: `Saved contents: ${content}`,
                        replyEffectStatus: "none",
                      },
                ),
            },
          }),
      });
      expect(writes).toBe(1);
      expect(reads).toBe(1);
      expect(plans).toBe(2);
      expect(evaluations).toBe(2);
      expect(result.finalMessage).toContain(content);
      expect(
        result.trajectory.steps.flatMap(
          (step) => step.result?.effectReceipts ?? [],
        ),
      ).toContainEqual(receipt);
      expect(await readFile(path, "utf8")).toBe(content);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["unsafe", "failure"])(
    "retains the incomplete notice and safe failure authority (%s)",
    async (kind) => {
      const result = await runPlannerLoop({
        context: { id: "incomplete-safe-relay" },
        runtime: {
          useModel: async () => ({
            text: "",
            toolCalls: [
              {
                id: "operation",
                name: "READ",
                arguments: { eliza_turn_scope: "more_work_pending" },
              },
            ],
          }),
        },
        executeToolCall: async () => ({
          success: kind !== "failure",
          turnComplete: false,
          userFacingText:
            kind === "failure"
              ? "Verification lookup failed."
              : '{"tool_calls":[{"name":"SECRET_TOOL"}]}',
        }),
        evaluate: async () => {
          throw Object.assign(new Error("rate limited"), { status: 429 });
        },
      });
      expect(result.finalMessage).toContain("request remains incomplete");
      expect(result.finalMessage).not.toContain("SECRET_TOOL");
      if (kind === "failure")
        expect(result.finalMessage).toContain("Verification lookup failed.");
      expect(result.evaluator?.success).toBe(false);
    },
  );
  it.each(["overflow", "abort", "signal"])(
    "preserves %s authority after a settled action even with provider HTTP status",
    async (kind) => {
      const controller = new AbortController();
      const error =
        kind === "overflow"
          ? new ElizaError("full context rejected", {
              code: PROVIDER_CONTEXT_OVERFLOW,
            })
          : Object.assign(new Error("caller cancelled"), {
              name: "AbortError",
              status: 429,
            });
      let executed = 0;
      const turn = runWithStreamingContext(
        { onStreamChunk: async () => {}, abortSignal: controller.signal },
        () =>
          runPlannerLoop({
            context: { id: "provider-failure-boundary" },
            runtime: {
              useModel: async () => ({
                text: "",
                toolCalls: [
                  {
                    id: "save",
                    name: "SAVE",
                    arguments: { eliza_turn_scope: "more_work_pending" },
                  },
                ],
              }),
            },
            executeToolCall: async () => {
              executed++;
              return {
                success: true,
                userFacingText: "Saved.",
                effectReceipts: [receipt],
              };
            },
            evaluate: async () => {
              if (kind === "signal") controller.abort(error);
              throw error;
            },
          }),
      );
      await expect(turn).rejects.toBe(error);
      expect(executed).toBe(1);
    },
  );
  it.each([false, true])(
    "preserves verified complete relays and internal effect failure authority (internal=%s)",
    async (internal) => {
      let modelCalls = 0;
      const result = await runPlannerLoop({
        context: {
          id: "provider-fallback-authority",
          events: [
            {
              id: "handler",
              type: "message_handler",
              metadata: { plan: { intents: ["save the requested record"] } },
            },
          ],
        },
        runtime: {
          useModel: async () => {
            if (++modelCalls > 1)
              throw Object.assign(new Error("rate limited"), { status: 429 });
            return {
              text: "",
              toolCalls: [
                {
                  id: "save",
                  name: "SAVE",
                  arguments: {
                    eliza_turn_scope: internal ? "more_work_pending" : "final",
                  },
                },
              ],
            };
          },
        },
        executeToolCall: async () => ({
          success: true,
          userFacingText: internal
            ? "PRIVATE INTERNAL RESULT"
            : "Saved the requested record.",
          verifiedUserFacing: true,
          turnComplete: true,
          ...(internal ? { transcriptVisibility: "internal" as const } : {}),
          effectReceipts: [receipt],
        }),
        evaluate: async () => {
          throw Object.assign(new Error("rate limited"), { status: 429 });
        },
      });
      if (internal) {
        expect(result.terminalFailure?.code).toBe(
          "EVALUATOR_REPLY_GENERATION_FAILED",
        );
        expect(result.finalMessage).toBeUndefined();
        expect(
          result.trajectory.steps.find((step) => step.result)?.result
            ?.replyFailure?.code,
        ).toBe("EVALUATOR_REPLY_GENERATION_FAILED");
      } else {
        expect(result.terminalFailure).toBeUndefined();
        expect(result.finalMessage).toBe("Saved the requested record.");
      }
      expect(
        result.trajectory.steps.filter((step) => step.toolCall),
      ).toHaveLength(1);
    },
  );
  it.each(["more_work_pending", "final"])(
    "preserves a real write without claiming unfinished readback completed after next model boundary 429 (%s)",
    async (scope) => {
      const directory = await mkdtemp(join(tmpdir(), "planner-incomplete-"));
      const path = join(directory, "index.html");
      const content = "<html><body>read me back exactly</body></html>";
      const version = `sha256:${createHash("sha256").update(content).digest("hex")}`;
      let mutations = 0;
      let plannerCalls = 0;
      const useModel = vi.fn(async () => {
        if (++plannerCalls > 1)
          throw Object.assign(new Error("token quota exceeded"), {
            status: 429,
          });
        return {
          text: "",
          toolCalls: [
            {
              id: "write",
              name: "FILE",
              arguments: {
                action: "write",
                path,
                content,
                eliza_turn_scope: scope,
              },
            },
          ],
        };
      });
      const evaluate = vi.fn(async () => {
        throw Object.assign(new Error("token quota exceeded"), { status: 429 });
      });
      try {
        const result = await runPlannerLoop({
          context: {
            id: "incomplete-provider",
            events: [
              {
                id: "handler",
                type: "message_handler",
                metadata: {
                  plan: {
                    intents: [
                      "write the HTML file",
                      "read the saved file and report its exact contents",
                    ],
                  },
                },
              },
            ],
          },
          runtime: { useModel },
          evaluate,
          executeToolCall: async () => {
            mutations++;
            await writeFile(path, content);
            expect(await readFile(path, "utf8")).toBe(content);
            return {
              success: true,
              userFacingText: "Wrote the HTML file.",
              verifiedUserFacing: true,
              turnComplete: true,
              effectReceipts: [
                {
                  ...receipt,
                  operation: "filesystem.write",
                  resource: { kind: "filesystem.file", id: path, version },
                  commit: {
                    kind: "durable",
                    id: `${path}#${version}`,
                    committedAt: receipt.observedAt,
                  },
                },
              ],
            };
          },
        });
        expect(mutations).toBe(1);
        expect(useModel).toHaveBeenCalledTimes(
          scope === "more_work_pending" ? 2 : 1,
        );
        expect(evaluate).toHaveBeenCalledTimes(
          scope === "more_work_pending" ? 0 : 1,
        );
        expect(await readFile(path, "utf8")).toBe(content);
        expect(result.terminalFailure).toMatchObject({
          code: "PLANNER_INCOMPLETE_PROVIDER_FAILURE",
          kind: "rate_limited",
          transient: false,
        });
        expect(result.evaluator?.success).toBe(false);
        expect(result.finalMessage).toContain("Wrote the HTML file.");
        expect(result.finalMessage).toContain("request remains incomplete");
        expect(
          result.trajectory.steps.find(
            (step) => step.result?.effectReceipts?.length,
          )?.result?.effectReceipts?.[0]?.resource.version,
        ).toBe(version);
        expect(result.trajectory.outcomeIntents).toEqual([
          "write the HTML file",
          "read the saved file and report its exact contents",
        ]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
  it("does not replay a committed mutation with nonretryable bookkeeping failure", async () => {
    const h = harness(2);
    const result = await runPlannerLoop({
      ...h,
      context: { id: "nonretryable-receipt" },
      codingMode: true,
    });
    const call = {
      id: "write",
      name: "WRITE",
      params: { path: "/workspace/file", content: "saved" },
    };
    const step = result.trajectory.steps.find((entry) => entry.toolCall);
    expect(step).toBeDefined();
    if (!step) throw new Error("Expected an executed step");
    step.toolCall = call;
    step.result = {
      success: false,
      effectReceipts: [receipt],
      failureProvenance: {
        kind: "persistence_error",
        boundary: "persistence",
        code: "FILE_STATE_TRACKING_FAILED",
        retryable: false,
      },
    };
    const partition = partitionRedundantSucceededCalls(
      [call],
      result.trajectory,
    );
    expect(partition.fresh).toEqual([]);
    expect(partition.nonRetryable).toEqual([call]);
  });
  it("keeps native reply schemas identical throughout the trajectory", async () => {
    const h = harness(4);
    const schemas: string[] = [];
    const useModel = h.runtime.useModel;
    h.runtime.useModel = async (type, input) => {
      schemas.push(JSON.stringify(input.tools));
      return useModel(type, input);
    };
    await runPlannerLoop({
      ...h,
      context: { id: "stable-reply-schema" },
      codingMode: true,
      tools: [
        ...["DISCOVER_ACTIONS", "MEMORY_SEARCH"].map((name) => ({
          name,
          description: name,
          parameters: {
            type: "object" as const,
            properties: { query: { type: "string" as const } },
          },
        })),
        {
          name: "REPLY",
          description: "Reply",
          parameters: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
      ],
    });
    expect(schemas).toHaveLength(4);
    expect(new Set(schemas).size).toBe(1);
  });
  it("settles source-bound outcome coverage without a scope-only planner round", async () => {
    let rounds = 0;
    const result = await runPlannerLoop({
      context: {
        id: "covered-outcome",
        events: [
          {
            id: "handler",
            type: "message_handler",
            metadata: { plan: { intents: ["read the requested file"] } },
          },
        ],
      },
      runtime: {
        useModel: async () => {
          if (++rounds > 1) throw new Error("Unnecessary scope-only round");
          return {
            text: "",
            toolCalls: [
              {
                id: "read",
                name: "READ",
                arguments: {
                  path: "/workspace/file",
                  eliza_turn_scope: "more_work_pending",
                },
              },
            ],
          };
        },
      },
      executeToolCall: async () => ({
        success: true,
        text: "File contains 42",
      }),
      evaluate: async () => ({
        decision: "FINISH",
        success: true,
        thought: "Requested file read",
        messageToUser: "The file contains 42.",
        requestFullyCovered: true,
        outcomeCoverage: [
          {
            intentId: "intent:1",
            status: "completed",
            evidenceStepIds: ["step:1"],
          },
        ],
      }),
    });
    expect(rounds).toBe(1);
    expect(result.evaluator?.success).toBe(true);
    expect(result.finalMessage).toBe("The file contains 42.");
  });

  it("does not dispatch an effect when its durable before-tool checkpoint fails", async () => {
    const executeToolCall = vi.fn();
    const checkpointFailure = new Error("Checkpoint storage unavailable");
    await expect(
      runPlannerLoop({
        context: { id: "checkpoint-failure" },
        runtime: {
          useModel: async () => ({
            text: "",
            toolCalls: [
              {
                id: "write",
                name: "WRITE",
                arguments: {
                  path: "/workspace/file",
                  eliza_turn_scope: "final",
                },
              },
            ],
          }),
        },
        executeToolCall,
        onCheckpoint: async (_state, phase) => {
          expect(phase).toBe("before_tool");
          throw checkpointFailure;
        },
      }),
    ).rejects.toThrow(checkpointFailure);
    expect(executeToolCall).not.toHaveBeenCalled();
  });

  it("rehydrates complete execution evidence but replans an unexecuted queue under fresh capabilities", async () => {
    const history = [
      { role: "user" as const, content: "Complete original evidence" },
    ];
    const seed: PlannerTrajectory = {
      context: { id: "original-context" },
      codingMode: false,
      steps: [
        {
          iteration: 3,
          toolCall: {
            id: "saved",
            name: "WRITE",
            params: { path: "/workspace/output" },
          },
          result: { success: true, effectReceipts: [receipt] },
        },
      ],
      archivedSteps: [],
      plannedQueue: [
        {
          id: "stale-write",
          name: "WRITE",
          params: { path: "/workspace/unapproved" },
        },
      ],
      evaluatorOutputs: [],
      modelHistory: history,
    };
    const executed: string[] = [];
    const result = await runPlannerLoop({
      context: { id: "fresh-authorized-context" },
      codingMode: false,
      resumeState: {
        trajectory: seed,
        modelUsage: { promptTokens: 100, completionTokens: 20, modelCalls: 2 },
      },
      runtime: {
        useModel: async () => ({
          text: "",
          toolCalls: [
            {
              id: "verify",
              name: "READ",
              arguments: {
                path: "/workspace/output",
                eliza_turn_scope: "final",
              },
            },
          ],
          usage: { promptTokens: 50, completionTokens: 5, totalTokens: 55 },
        }),
      },
      executeToolCall: async (call) => {
        executed.push(call.name);
        return { success: true, continueChain: false, text: "Verified" };
      },
    });
    expect(executed).toEqual(["READ"]);
    expect(result.trajectory.steps[0]).toEqual(seed.steps[0]);
    expect(result.trajectory.steps[1]?.iteration).toBe(4);
    expect(result.trajectory.modelHistory?.[0]).toEqual(history[0]);
    expect(result.trajectory.context.id).toBe("fresh-authorized-context");
    expect(result.modelUsage).toMatchObject({
      promptTokens: 150,
      completionTokens: 25,
      modelCalls: 3,
    });
    expect(seed.plannedQueue[0]?.id).toBe("stale-write");
  });

  it("does not reset an exhausted cumulative token budget when resuming", async () => {
    const useModel = vi.fn();
    const result = await runPlannerLoop({
      context: { id: "fresh-context" },
      resumeState: {
        trajectory: {
          context: { id: "original" },
          steps: [],
          archivedSteps: [],
          plannedQueue: [],
          evaluatorOutputs: [],
        },
        modelUsage: { promptTokens: 100, completionTokens: 20, modelCalls: 2 },
      },
      config: { maxTrajectoryPromptTokens: 100 },
      runtime: { useModel },
      executeToolCall: async () => ({ success: true }),
    });
    expect(useModel).not.toHaveBeenCalled();
    expect(result.terminalFailure?.kind).toBe("resource_limit");
    expect(result.modelUsage?.promptTokens).toBe(100);
  });

  it.each([false, true])(
    "advances a pending batch after a committed write without a redundant evaluator call (visible=%s)",
    async (visible) => {
      let modelCalls = 0;
      const executed: string[] = [];
      const result = await runPlannerLoop({
        codingMode: false,
        context: { id: "pending-write-read" },
        runtime: {
          useModel: async () => {
            if (++modelCalls > 1)
              throw new Error(
                "Unexpected evaluator call between committed write and queued verification",
              );
            return {
              text: "",
              toolCalls: ["WRITE", "READ"].map((name) => ({
                id: `pending-${name}`,
                name,
                arguments: {
                  path: "/workspace/output",
                  eliza_turn_scope: "more_work_pending",
                },
              })),
            };
          },
        },
        executeToolCall: async (call) => {
          executed.push(call.name);
          return call.name === "WRITE"
            ? {
                success: true,
                ...(visible
                  ? {
                      verifiedUserFacing: true,
                      turnComplete: true,
                      userFacingText: "Written",
                    }
                  : { transcriptVisibility: "internal" as const }),
                effectReceipts: [receipt],
              }
            : { success: true, text: "Verified output", continueChain: false };
        },
      });
      expect(executed).toEqual(["WRITE", "READ"]);
      expect(modelCalls).toBe(1);
      expect(
        result.trajectory.steps.find((step) => step.toolCall?.name === "WRITE")
          ?.result?.effectReceipts,
      ).toEqual([receipt]);
    },
  );

  it("repairs a typed pre-execution rejection before evaluating completion", async () => {
    let rounds = 0;
    const executed: string[] = [];
    const result = await runPlannerLoop({
      codingMode: false,
      context: { id: "rejected-command" },
      runtime: {
        useModel: async () => {
          if (++rounds > 2)
            return {
              text: JSON.stringify({
                decision: "FINISH",
                success: false,
                thought:
                  "Rejected attempt retained; corrected command completed.",
                messageToUser: "The corrected command completed.",
              }),
            };
          return {
            text: "",
            toolCalls: [
              {
                id: `repair-${rounds}`,
                name: "TERMINAL_SHELL",
                arguments: {
                  command:
                    rounds === 1
                      ? "invalid multiline"
                      : "corrected single line",
                  eliza_turn_scope: "more_work_pending",
                },
              },
            ],
          };
        },
      },
      executeToolCall: async (call) => {
        if (executed.length === 1) expect(rounds).toBe(2);
        executed.push(String(call.params?.command));
        return rounds === 1
          ? {
              success: false,
              text: "Command must be a single line",
              failureProvenance: {
                kind: "handler_error",
                boundary: "handler",
                code: "TERMINAL_COMMAND_SINGLE_LINE_REQUIRED",
                retryable: true,
              },
              data: { acceptance: "rejected", executionStatus: "not_started" },
            }
          : {
              success: true,
              text: "Created and verified",
              continueChain: false,
            };
      },
    });
    expect(executed).toEqual(["invalid multiline", "corrected single line"]);
    expect(
      result.trajectory.steps.some(
        (step) =>
          step.result?.failureProvenance?.code ===
          "TERMINAL_COMMAND_SINGLE_LINE_REQUIRED",
      ),
    ).toBe(true);
  });

  it("replans after a failed prerequisite without running its dependent queued write", async () => {
    let round = 0;
    const executed: string[] = [];
    const result = await runPlannerLoop({
      codingMode: true,
      context: { id: "failed-batch-prerequisite" },
      runtime: {
        useModel: async () => {
          round++;
          if (round > 2) throw new Error("Unexpected planner retry");
          return {
            text: "",
            toolCalls: (round === 1 ? ["READ", "WRITE"] : ["READ"]).map(
              (name, index) => ({
                id: `batch-${round}-${index}`,
                name,
                arguments: {
                  path: "/workspace/input",
                  eliza_turn_scope: "more_work_pending",
                },
              }),
            ),
          };
        },
      },
      executeToolCall: async (call) => {
        executed.push(call.name);
        return executed.length === 1
          ? {
              success: false,
              text: "Input missing",
              data: { readOnlyOperation: true },
            }
          : { success: true, text: "Input recovered", continueChain: false };
      },
    });
    expect(round).toBe(2);
    expect(executed).toEqual(["READ", "READ"]);
    expect(
      result.trajectory.steps.some((step) => step.toolCall?.name === "WRITE"),
    ).toBe(false);
    expect(
      result.trajectory.steps.find((step) => step.result?.success === false)
        ?.result?.text,
    ).toBe("Input missing");
  });

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
        tools: ["DISCOVER_ACTIONS", "MEMORY_SEARCH"].map((name) => ({
          name,
          description: "Read requested evidence",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        })),
        codingMode,
      });
      expect(h.executed).toHaveLength(40);
      if (codingMode)
        expect(modelCalls.mock.calls[0]?.[1]).toMatchObject({ stream: false });
      expect(modelCalls.mock.calls[0]?.[1]).toMatchObject({
        providerOptions: {
          eliza: {
            thinking: "off",
            preferLosslessToolArguments: true,
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
  it.each([false, true])(
    "cancels after a settled operation without dispatching the next call (coding=%s)",
    async (codingMode) => {
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
            codingMode,
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
                transcriptVisibility: "internal",
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
    },
  );
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
  it("preserves successful effects and failed reads when repeated failures stop coding", async () => {
    let calls = 0;
    let effects = 0;
    const result = await runPlannerLoop({
      codingMode: true,
      context: { id: "stale-after-write" },
      config: { maxRepeatedFailures: 2 },
      runtime: {
        useModel: async () => {
          calls++;
          if (calls > 4) throw new Error("Repeated failure limit was bypassed");
          return {
            text: "",
            toolCalls: [
              {
                id: `call-${calls}`,
                name: calls === 1 ? "WRITE" : "READ",
                arguments: {
                  file_path: "changed.ts",
                  eliza_turn_scope: "more_work_pending",
                },
              },
            ],
          };
        },
      },
      executeToolCall: async (call) => {
        if (call.name === "WRITE") {
          effects++;
          return {
            success: true,
            text: "File written",
            effectReceipts: [receipt],
          };
        }
        return {
          success: false,
          text: "stale_read: expected old revision",
          error: "stale_read",
        };
      },
    });
    expect(calls).toBe(4);
    expect(effects).toBe(1);
    expect(result.trajectory.steps).toHaveLength(4);
    expect(result.trajectory.steps[0]?.result?.effectReceipts).toEqual([
      receipt,
    ]);
    expect(
      result.trajectory.steps
        .slice(1)
        .every((step) => step.result?.success === false),
    ).toBe(true);
    expect(result.evaluator?.success).toBe(false);
    expect(result.terminalFailure?.kind).toBe("resource_limit");
    expect(result.finalMessage).toContain("repeated tool failures");
  });

  it.each([
    {
      code: "MODEL_OUTPUT_INCOMPLETE",
      kind: "provider_issue",
      transient: false,
      network: false,
    },
    {
      code: "PROVIDER_CONTEXT_OVERFLOW",
      kind: "context_overflow",
      transient: false,
      network: false,
    },
    {
      code: "MODEL_PROVIDER_TRANSPORT_FAILED",
      kind: "provider_issue",
      transient: true,
      network: true,
    },
  ])(
    "preserves settled effects without retry after $code",
    async ({ code, kind, transient, network }) => {
      let calls = 0;
      let effects = 0;
      const result = await runPlannerLoop({
        codingMode: true,
        context: { id: "incomplete-after-write" },
        runtime: {
          useModel: async () => {
            calls++;
            if (calls > 1 && network)
              throw Object.assign(
                new Error("Provider transport failed", {
                  cause: Object.assign(new TypeError("socket closed"), {
                    code: "ECONNRESET",
                  }),
                }),
                { name: "AI_APICallError" },
              );
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
        transient,
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
    {
      codingMode: false,
      error: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
    },
    {
      codingMode: true,
      error: Object.assign(new Error("Invalid JSON schema"), {
        statusCode: 400,
      }),
    },
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
