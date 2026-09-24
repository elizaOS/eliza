/** Exercises real discovery, execution and planner settlement with deterministic model responses. */

import { randomUUID } from "node:crypto";
import { createSQLiteTestRuntime } from "@elizaos/testing/sqlite-adapter";
import { describe, expect, it } from "vitest";
import type { PlannerRuntime } from "../../../../../packages/core/src/runtime/planner-types.ts";
import type { Action } from "../../../../../packages/core/src/types/components.ts";
import type { ContextObject } from "../../../../../packages/core/src/types/context-object.ts";
import type { Memory } from "../../../../../packages/core/src/types/memory.ts";
import { ModelType } from "../../../../../packages/core/src/types/model.ts";
import { runPlannerLoop } from "../../runtime/planner-loop.ts";
import { executeV5PlannedToolCall } from "./planned-tool.ts";
import { createPlannerToolDiscoveryAction } from "./tool-discovery.ts";

describe("discovery denial through planner settlement", () => {
  it.each([false, true])(
    "settles discovery denial without masking a real write failure (%s)",
    async (writeFailure) => {
      const runtime = createSQLiteTestRuntime({
        character: { name: "Discovery regression", bio: "Test" },

        logLevel: "fatal",
      });
      await runtime.initialize();
      try {
        const message: Memory = {
          id: randomUUID(),
          agentId: runtime.agentId,
          entityId: randomUUID(),
          roomId: randomUUID(),
          content: {
            text: writeFailure
              ? "Update the record, then read the page title."
              : "Read the page title. Do not change notes.",
            source: "client_chat",
          },
        };
        await runtime.ensureConnection({
          entityId: message.entityId,
          roomId: message.roomId,
          worldId: randomUUID(),
          source: "client_chat",
          type: "DM",
        });
        const context: ContextObject = {
          id: "discovery-denial",
          events: [
            {
              id: message.id,
              type: "message",
              source: "user",
              createdAt: 1,
              message: { role: "user", content: message.content.text },
            },
          ],
        };
        let reads = 0;
        const read: Action = {
          name: "READ_PAGE",
          description: "Read the page title without changing records.",
          parameters: [],
          validate: async () => true,
          handler: async () => {
            reads++;
            return {
              success: true,
              transcriptVisibility: "internal",
              modelReplyRequired: true,
              data: { readOnlyOperation: true, title: "Example Domain" },
            };
          },
        };
        const loaded: Action[][] = [];
        const discovery = createPlannerToolDiscoveryAction([read], (actions) =>
          loaded.push(actions),
        );
        const failedWrite: Action = {
          name: "WRITE_RECORD",
          description: "Update the requested record",
          parameters: [],
          validate: async () => true,
          handler: async () => ({
            success: false,
            error: "The record could not be written.",
          }),
        };
        const actions = [discovery, read, failedWrite];
        const calls: Array<{
          type: string;
          input: Parameters<PlannerRuntime["useModel"]>[1];
        }> = [];
        const plans = [
          {
            text: "",
            toolCalls: [
              {
                id: "describe",
                name: writeFailure ? "WRITE_RECORD" : "DISCOVER_TOOLS",
                arguments: {
                  ...(writeFailure
                    ? {}
                    : { names: ["READ_PAGE", "DENIED"], mode: "describe" }),
                  eliza_turn_scope: "more_work_pending",
                },
              },
            ],
          },
          {
            text: "",
            toolCalls: [
              {
                id: "read",
                name: "READ_PAGE",
                arguments: { eliza_turn_scope: "more_work_pending" },
              },
            ],
          },
          {
            text: "",
            toolCalls: [
              {
                id: "reply",
                name: "REPLY",
                arguments: {
                  text: "The page title is Example Domain.",
                  eliza_turn_scope: "final",
                },
              },
            ],
          },
        ];
        let planIndex = 0;
        let finalEvaluations = 0;
        const plannerRuntime: PlannerRuntime = {
          useModel: async (type, input) => {
            calls.push({ type, input });
            if (type === ModelType.ACTION_PLANNER) {
              const next = plans[planIndex++];
              if (!next) throw new Error("Unexpected extra planner call");
              return next;
            }
            if (type === ModelType.RESPONSE_HANDLER && planIndex < 3) {
              return JSON.stringify({
                thought: "Read and final synthesis remain pending.",
                decision: "CONTINUE",
                success: false,
              });
            }
            if (
              type === ModelType.RESPONSE_HANDLER &&
              ++finalEvaluations === 1
            ) {
              return JSON.stringify({
                thought: "The actual page read supports this answer.",
                decision: "FINISH",
                success: true,
                messageToUser: "The page title is Example Domain.",
              });
            }
            throw new Error(`Unexpected model call ${type}`);
          },
        };
        const result = await runPlannerLoop({
          runtime: plannerRuntime,
          context,
          config: { maxIterations: 6 },
          executeToolCall: (toolCall) =>
            executeV5PlannedToolCall({
              runtime,
              plannerRuntime,
              plannerContext: context,
              toolCall,
              executorCtx: {
                message,
                state: { values: {}, data: {}, text: "" },
                userRoles: ["USER"],
                activeContexts: ["general"],
              },
              executorOptions: { actions },
            }),
        });
        expect(result.trajectory.steps[0].result).toMatchObject({
          success: false,
          error: expect.stringContaining(
            writeFailure ? "could not be written" : "not admitted",
          ),
        });
        expect(reads).toBe(1);
        if (writeFailure) {
          expect(result.finalMessage).not.toBe(
            "The page title is Example Domain.",
          );
          expect(result.finalMessage).toMatch(/failed|could not be written/i);
          expect(
            calls.some(({ type }) => type === ModelType.RESPONSE_HANDLER),
          ).toBe(true);
          return;
        }
        expect(result.finalMessage).toBe("The page title is Example Domain.");
        expect(calls.map(({ type }) => type)).toEqual([
          ModelType.ACTION_PLANNER,
          ModelType.ACTION_PLANNER,
          ModelType.ACTION_PLANNER,
        ]);
        expect(
          result.trajectory.steps[0].result?.data?.catalog,
        ).toBeUndefined();
        expect(loaded).toEqual([]);
        const finalInput = JSON.stringify(calls[2].input);
        expect(finalInput).toContain("not admitted");
        expect(finalInput).toContain("Example Domain");
        expect(finalInput).toContain("Do not change notes.");
      } finally {
        await runtime.stop();
        await runtime.close();
      }
    },
  );
});
