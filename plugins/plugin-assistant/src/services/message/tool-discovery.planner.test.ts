/** Exercises real discovery, execution and planner settlement with deterministic model responses. */

import { randomUUID } from "node:crypto";
import type {
  Action,
  ContextObject,
  Memory,
  PlannerRuntime,
} from "@elizaos/core";
import {
  buildPlannerToolsFromActions,
  CORE_PLANNER_TERMINALS,
  ModelType,
  promoteSubactionsToActions,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { describe, expect, it } from "vitest";
import { runPlannerLoop } from "../../runtime/planner-loop.ts";
import { executeV5PlannedToolCall } from "./planned-tool.ts";
import { createPlannerToolDiscoveryAction } from "./tool-discovery.ts";

describe("discovery denial through planner settlement", () => {
  it.each([
    {
      writeFailure: false,
      discoveryName: "DISCOVER_ACTIONS",
      loadSuccess: false,
    },
    {
      writeFailure: true,
      discoveryName: "DISCOVER_ACTIONS",
      loadSuccess: false,
    },
    {
      writeFailure: false,
      discoveryName: "DISCOVER_ACTIONS",
      loadSuccess: true,
    },
    { writeFailure: false, discoveryName: "DISCOVER_TOOLS", loadSuccess: true },
  ])(
    "settles native discovery and executes admitted work: %j",
    async ({ writeFailure, discoveryName, loadSuccess }) => {
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
        const tools = [...CORE_PLANNER_TERMINALS];
        const discovery = createPlannerToolDiscoveryAction(
          [read],
          (actions) => {
            loaded.push(actions);
            tools.push(...buildPlannerToolsFromActions(actions));
          },
        );
        tools.push(...buildPlannerToolsFromActions([discovery]));
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
                name: writeFailure ? "WRITE_RECORD" : discoveryName,
                arguments: {
                  ...(writeFailure
                    ? {}
                    : {
                        names: loadSuccess
                          ? ["READ_PAGE"]
                          : ["READ_PAGE", "DENIED"],
                        mode: loadSuccess ? "load" : "describe",
                      }),
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
          ...(loadSuccess ? { tools } : {}),
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
        if (loadSuccess) {
          expect(result.trajectory.steps[0].toolCall?.name).toBe(
            "DISCOVER_ACTIONS",
          );
          expect(result.trajectory.steps[0].result?.success).toBe(true);
          expect(loaded).toEqual([[read]]);
          expect(reads).toBe(1);
          expect(result.finalMessage).toBe("The page title is Example Domain.");
          const initial = calls[0].input as { tools?: Array<{ name: string }> };
          expect(
            initial.tools?.some((tool) => tool.name === "DISCOVER_ACTIONS"),
          ).toBe(true);
          expect(
            initial.tools?.some((tool) => tool.name === "DISCOVER_TOOLS"),
          ).toBe(false);
          return;
        }
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

describe("over-budget catalog read through planner settlement", () => {
  it("reads the complete index, describes one exact name and completes without the full catalog", async () => {
    const runtime = createSQLiteTestRuntime({
      character: { name: "Discovery index", bio: "Test" },

      logLevel: "fatal",
    });
    await runtime.initialize();
    try {
      // Live 2026-10-30 (tj-7138d70800aff4): NOTES_LIST was exposed, the
      // planner read describe,names=[] and the full catalog filled the next
      // planner and evaluator requests.
      const message: Memory = {
        id: randomUUID(),
        agentId: runtime.agentId,
        entityId: randomUUID(),
        roomId: randomUUID(),
        content: { text: "what notes do I have?", source: "client_chat" },
      };
      await runtime.ensureConnection({
        entityId: message.entityId,
        roomId: message.roomId,
        worldId: randomUUID(),
        source: "client_chat",
        type: "DM",
      });
      const context: ContextObject = {
        id: "discovery-index",
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
      const lists: unknown[] = [];
      const notes = promoteSubactionsToActions(
        {
          name: "NOTES",
          description: "Create and list saved notes.",
          descriptionCompressed: "notes: list, create",
          parameters: [
            {
              name: "action",
              description: "Operation",
              required: true,
              schema: { type: "string", enum: ["list", "create"] },
            },
          ],
          validate: async () => true,
          handler: async (_runtime, _message, _state, options) => {
            lists.push(options?.parameters?.action);
            return {
              success: true,
              transcriptVisibility: "internal",
              modelReplyRequired: true,
              data: { readOnlyOperation: true, notes: ["Groceries"] },
            };
          },
        },
        { overrides: { list: { descriptionCompressed: "list saved notes" } } },
      );
      const calendarGuidance = "Exact calendar guidance Ω. ".repeat(3000);
      const calendar = promoteSubactionsToActions({
        name: "CALENDAR",
        description: `Calendar operations. ${calendarGuidance}`,
        parameters: [
          {
            name: "action",
            description: "Operation",
            required: true,
            schema: { type: "string", enum: ["create_event", "search"] },
          },
          {
            name: "details",
            description: calendarGuidance,
            schema: { type: "string" },
          },
        ],
        validate: async () => true,
        handler: async () => ({ success: true }),
      });
      const notesList = notes.find((action) => action.name === "NOTES_LIST");
      if (!notesList) throw new Error("Missing NOTES_LIST");
      const discovery = createPlannerToolDiscoveryAction(
        [...notes, ...calendar],
        () => {},
      );
      const fullDefinitionChars = JSON.stringify(
        (
          await discovery.handler?.(runtime, message, undefined, {
            parameters: { names: ["CALENDAR", "NOTES"], mode: "describe" },
          })
        )?.data,
      ).length;
      const tools = [
        ...CORE_PLANNER_TERMINALS,
        ...buildPlannerToolsFromActions([discovery, notesList]),
      ];
      const plans = [
        {
          id: "catalog",
          name: "DISCOVER_ACTIONS",
          arguments: { mode: "describe", names: [] },
        },
        {
          id: "describe",
          name: "DISCOVER_ACTIONS",
          arguments: { mode: "describe", names: ["NOTES_LIST"] },
        },
        { id: "list", name: "NOTES_LIST", arguments: { action: "list" } },
        {
          id: "reply",
          name: "REPLY",
          arguments: { text: "You have one note: Groceries." },
        },
      ].map((toolCall, index, all) => ({
        text: "",
        toolCalls: [
          {
            ...toolCall,
            arguments: {
              ...toolCall.arguments,
              eliza_turn_scope:
                index === all.length - 1 ? "final" : "more_work_pending",
            },
          },
        ],
      }));
      const calls: Array<{
        type: string;
        input: Parameters<PlannerRuntime["useModel"]>[1];
      }> = [];
      let planIndex = 0;
      const plannerRuntime: PlannerRuntime = {
        useModel: async (type, input) => {
          calls.push({ type, input });
          if (type === ModelType.ACTION_PLANNER) {
            const next = plans[planIndex++];
            if (!next) throw new Error("Unexpected extra planner call");
            return next;
          }
          throw new Error(`Unexpected model call ${type}`);
        },
      };
      const result = await runPlannerLoop({
        runtime: plannerRuntime,
        context,
        config: { maxIterations: 6 },
        tools,
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
            executorOptions: {
              actions: [discovery, ...notes, ...calendar],
            },
          }),
      });
      const [catalogStep, describeStep] = result.trajectory.steps;
      expect(catalogStep.result).toMatchObject({
        success: true,
        data: { catalogDetail: "index", completeDefinitions: false },
      });
      expect(catalogStep.result?.data?.catalog).toEqual([
        {
          name: "CALENDAR",
          children: ["CALENDAR_CREATE_EVENT", "CALENDAR_SEARCH"],
        },
        {
          name: "NOTES",
          summary: "notes: list, create",
          children: ["NOTES_CREATE", "NOTES_LIST"],
          childSummaries: { NOTES_LIST: "list saved notes" },
        },
      ]);
      expect(describeStep.result?.data?.catalog).toMatchObject([
        { name: "NOTES_LIST", description: notesList.description },
      ]);
      expect(lists).toEqual(["list"]);
      expect(result.finalMessage).toBe("You have one note: Groceries.");
      // Every model request after the catalog read stays smaller than the
      // full definitions alone.
      expect(calls).toHaveLength(plans.length);
      for (const { input } of calls.slice(1))
        expect(JSON.stringify(input).length).toBeLessThan(fullDefinitionChars);
    } finally {
      await runtime.stop();
      await runtime.close();
    }
  });
});
