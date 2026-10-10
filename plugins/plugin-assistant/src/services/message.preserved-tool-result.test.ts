import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import {
  calendarReadBindingEvaluator,
  calendarReadBindingField,
} from "../../../plugin-calendar/src/read-binding.ts";
import { createTrackedWorkRecapDirectRoutingRule } from "../../../plugin-personal-assistant/src/lifeops/briefing/direct-routing.ts";
import { createAssistantPlugin } from "../index.ts";

/**
 * Preserved-tool-result rescue when the planner loop dies mid-turn: drives the
 * real `DefaultMessageService.handleMessage` pipeline (real AgentRuntime,
 * in-memory adapter, real planner loop and action execution) with only model
 * transport stubbed. Reproduces the live 2026-08-07/08 incident class — a tool
 * completes, then the post-tool evaluator model call fails — and asserts the
 * completed tool's `userFacingText` reaches the user instead of the canned
 * transient-failure reply, alongside an explicit incomplete outcome.
 * Internal diagnostics remain private. Also unit-covers `preservedSettledToolResult`
 * candidate selection.
 */

import type {
  Action,
  ActionResult,
  AgentRuntime,
  Content,
  HandlerCallback,
  Memory,
  UUID,
} from "@elizaos/core";
import {
  ChannelType,
  createCharacter,
  ElizaError,
  EventType,
  ModelType,
  PROVIDER_CONTEXT_OVERFLOW,
  registerDirectActionRoutingRule,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlannerToolResult } from "../runtime/planner-loop.ts";
import {
  answerlessToolTurnReport,
  DefaultMessageService,
  preservedSettledToolResult,
  runV5MessageRuntimeStage1,
  subAgentCompletionRelayBody,
} from "./message.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000081" as UUID;
const USER_ID = "00000000-0000-0000-0000-000000000082" as UUID;

const USER_FACING = "calendar event saved: eliza-test, tomorrow 3pm.";
const DIAGNOSTIC = "calendar.create op=create id=ev-1 ok exit=0";

// The live evaluator failure shape: a provider/wrapper error with NO HTTP
// status, so the planner-loop's in-loop provider-error relay does not fire and
// the failure propagates to the message service's rescue seam.
const EVALUATOR_FAILURE = new Error(
  "[cli-inference:sdk] subscription rate limit reached: session limit hit",
);

function stageOneToolTurn(replyEffectStatus: "none" | "non_applied" = "none") {
  return {
    text: "",
    toolCalls: [
      {
        id: "handle-response-1",
        name: "HANDLE_RESPONSE",
        arguments: {
          shouldRespond: "RESPOND",
          thought: "Look up the entry.",
          contexts: ["general"],
          intents: ["look up entry"],
          candidateActionNames: ["LOOKUP"],
          replyText: "",
          replyEffectStatus,
          facts: [],
          relationships: [],
          addressedTo: [],
          requiresTool: true,
        },
      },
    ],
    finishReason: "tool_calls",
  };
}

function plannerCalendarCall() {
  return {
    text: "",
    thought: "Look up the requested entry.",
    toolCalls: [
      {
        id: "calendar-create-1",
        name: "LOOKUP",
        arguments: { action: "create" },
      },
    ],
  };
}

function makeMessage(runtime: AgentRuntime, text: string): Memory {
  return {
    entityId: USER_ID,
    agentId: runtime.agentId,
    roomId: runtime.agentId,
    content: {
      text,
      source: "client_chat",
      channelType: ChannelType.DM,
    },
    createdAt: Date.now(),
  };
}

interface Harness {
  runtime: AgentRuntime;
  callback: HandlerCallback;
  callbacks: Content[];
  sent: Content[];
  reportedScopes: string[];
}

const activeRuntimes: AgentRuntime[] = [];

async function createHarness(options: {
  actionResult: Record<string, unknown>;
  actionGate?: (roomId: UUID) => Promise<void>;
  evaluatorFailure?: Error;
  onEvaluator?: () => void;
  plannerCall?: () => ReturnType<typeof plannerCalendarCall>;
}): Promise<Harness> {
  const runtime = createSQLiteTestRuntime({
    plugins: [createAssistantPlugin()],
    character: createCharacter({
      id: AGENT_ID,
      name: "Preserved Result Integration",
      bio: "Exercises the planner-loop failure rescue seam.",
      settings: {},
    }),

    logLevel: "fatal",
    enableAutonomy: false,
  });
  await runtime.initialize({ skipMigrations: true });
  activeRuntimes.push(runtime);

  await runtime.createWorld({
    id: runtime.agentId,
    agentId: runtime.agentId,
    name: "Test caller authority",
    metadata: { roles: { [USER_ID]: "USER" } },
  });
  await runtime.ensureRoomExists({
    id: runtime.agentId,
    source: "client_chat",
    type: ChannelType.DM,
    worldId: runtime.agentId,
  });

  runtime.actions.length = 0;
  runtime.evaluators.length = 0;
  runtime.composeState = vi.fn(async () => ({
    values: { availableContexts: "general" },
    data: {},
    text: "Deterministic preserved-tool-result state.",
  })) as AgentRuntime["composeState"];

  const calendarAction: Action = {
    name: "LOOKUP",
    description: "Looks up a stored entry.",
    parameters: [
      {
        name: "action",
        description: "Lookup operation",
        required: true,
        schema: { type: "string", enum: ["create", "verify"] },
      },
    ],
    validate: async () => true,
    handler: async (_runtime, message) => {
      await options.actionGate?.(message.roomId);
      return options.actionResult as never;
    },
  };
  runtime.registerAction(calendarAction);

  // Stage 1 succeeds and promotes to planning; every LATER response-handler
  // call (the post-tool evaluator) dies like the live incident. The failure
  // reply generator's TEXT_* calls die the same way, forcing the canned
  // template path when nothing user-facing is preserved.
  let stageOneServed = false;
  runtime.registerModel(
    ModelType.RESPONSE_HANDLER,
    async () => {
      if (!stageOneServed) {
        stageOneServed = true;
        return stageOneToolTurn();
      }
      options.onEvaluator?.();
      throw options.evaluatorFailure ?? EVALUATOR_FAILURE;
    },
    "preserved-tool-result-test",
    100,
  );
  runtime.registerModel(
    ModelType.ACTION_PLANNER,
    async () => options.plannerCall?.() ?? plannerCalendarCall(),
    "preserved-tool-result-test",
    100,
  );
  runtime.registerModel(
    ModelType.TEXT_SMALL,
    async () => {
      throw options.evaluatorFailure ?? EVALUATOR_FAILURE;
    },
    "preserved-tool-result-test",
    100,
  );

  const reportedScopes: string[] = [];
  const originalReportError = runtime.reportError.bind(runtime);
  runtime.reportError = ((scope, error, context) => {
    reportedScopes.push(String(scope));
    return originalReportError(scope, error, context);
  }) as AgentRuntime["reportError"];

  const callbacks: Content[] = [];
  const sent: Content[] = [];
  runtime.registerSendHandler(
    "client_chat",
    async (_runtime, _target, content) => {
      sent.push(content);
      return undefined;
    },
  );
  const callback: HandlerCallback = async (content: Content) => {
    callbacks.push(content);
    await runtime.sendMessageToTarget(
      { source: "client_chat", roomId: runtime.agentId },
      content,
    );
    return [];
  };

  return { runtime, callback, callbacks, sent, reportedScopes };
}

function visibleTexts(contents: Content[]): string[] {
  return contents
    .map((content) => (typeof content.text === "string" ? content.text : ""))
    .filter((text) => text.trim().length > 0);
}

describe("planner-loop death after a completed tool", () => {
  it.each([false, true])(
    "keeps composite dossier coverage distinct from an explicit Calendar read (explicit=%s)",
    async (explicitCalendar) => {
      const h = await createHarness({ actionResult: { success: true } });
      const world = await h.runtime.getWorld(h.runtime.agentId);
      if (!world) throw new Error("Missing owner world");
      await h.runtime.updateWorlds([
        {
          ...world,
          metadata: {
            ownership: { ownerId: USER_ID },
            roles: { [USER_ID]: "OWNER" },
          },
        },
      ]);
      h.runtime.actions.length = 0;
      const executed: string[] = [];
      const dossierText =
        "Your calendar is clear today. You have one open reminder.";
      h.runtime.registerAction({
        name: "BRIEF",
        description:
          "Compose the owner's daily dossier from available sources.",
        contexts: ["productivity", "tasks"],
        tags: ["domain:briefing", "resource:tracked-work", "capability:read"],
        roleGate: { minRole: "OWNER" },
        validate: async () => true,
        handler: async () => {
          executed.push("BRIEF");
          return {
            success: true,
            text: dossierText,
            userFacingText: dossierText,
            turnComplete: true,
            data: {
              briefing: {
                kind: "evening",
                period: "today",
                sections: { calendar: [], life: [{ title: "Stretch" }] },
              },
            },
          };
        },
      });
      for (const name of ["CALENDAR_FEED", "INBOX", "CONNECTOR"])
        h.runtime.registerAction({
          name,
          description: name,
          contexts:
            name === "CALENDAR_FEED" ? ["calendar"] : ["email", "connectors"],
          validate: async () => true,
          handler: async () => {
            executed.push(name);
            throw new Error(
              "This composite result must not invent extra reads",
            );
          },
        });
      registerDirectActionRoutingRule(
        h.runtime,
        createTrackedWorkRecapDirectRoutingRule(),
      );
      h.runtime.registerResponseHandlerFieldEvaluator(calendarReadBindingField);
      h.runtime.responseHandlerEvaluators.push(calendarReadBindingEvaluator);
      const intents = [
        "Compile my daily dossier using connected sources available now",
        ...(explicitCalendar ? ["Read today's Calendar agenda"] : []),
      ];
      let responseCalls = 0;
      h.runtime.registerModel(
        ModelType.RESPONSE_HANDLER,
        async () => {
          if (++responseCalls === 1) {
            const result = stageOneToolTurn();
            Object.assign(result.toolCalls[0].arguments, {
              contexts: [
                "productivity",
                ...(explicitCalendar ? ["calendar"] : []),
              ],
              intents,
              candidateActionNames: [],
              calendarReadBindings: explicitCalendar
                ? [
                    {
                      intentId: "intent:2",
                      operation: "feed",
                      execution: "required",
                    },
                  ]
                : [],
            });
            return result;
          }
          return JSON.stringify({
            thought:
              "The composite briefing returned its selected source results.",
            success: true,
            decision: "FINISH",
            requestFullyCovered: true,
            outcomeCoverage: intents.map((_, index) => ({
              intentId: `intent:${index + 1}`,
              status: "completed",
              evidenceStepIds: ["step:1"],
            })),
            messageToUser: dossierText,
            replyEffectStatus: "none",
          });
        },
        "dossier-coverage-test",
        200,
      );
      h.runtime.registerModel(
        ModelType.ACTION_PLANNER,
        async (_runtime, params) => {
          const tools = params.tools?.map((tool) => tool.name) ?? [];
          expect(tools).toContain("BRIEF");
          expect(tools.includes("CALENDAR_FEED")).toBe(explicitCalendar);
          return {
            text: "",
            toolCalls: [{ id: "brief", name: "BRIEF", arguments: {} }],
          };
        },
        "dossier-coverage-test",
        200,
      );
      const message = {
        ...makeMessage(
          h.runtime,
          `Give me my daily dossier using the connected sources available now.${explicitCalendar ? " Also read today's Calendar agenda." : ""}`,
        ),
        id: "00000000-0000-0000-0000-000000000095" as UUID,
      };
      const outcome = await runV5MessageRuntimeStage1({
        runtime: h.runtime,
        message,
        state: await h.runtime.composeState(message),
        responseId: "00000000-0000-0000-0000-000000000096" as UUID,
        callback: h.callback,
      });
      expect(executed).toEqual(["BRIEF"]);
      if (outcome.kind !== "planned_reply" && outcome.kind !== "direct_reply")
        throw new Error("Missing dossier reply");
      const text = outcome.result.responseContent?.text;
      if (explicitCalendar) {
        expect(text).toContain("couldn't confirm");
        expect(text).not.toContain("calendar is clear");
      } else {
        expect(text).toBe(dossierText);
        expect(text).not.toMatch(/Gmail|inbox|not connected/);
      }
      expect(responseCalls).toBe(2);
    },
  );

  it.each([false, true])(
    "preserves the conditional Calendar branch through the real field runner (note exists=%s)",
    async (exists) => {
      const h = await createHarness({ actionResult: { success: true } });
      const world = await h.runtime.getWorld(h.runtime.agentId);
      if (!world) throw new Error("Missing owner world");
      await h.runtime.updateWorlds([
        {
          ...world,
          metadata: {
            ownership: { ownerId: USER_ID },
            roles: { [USER_ID]: "OWNER" },
          },
        },
      ]);
      h.runtime.contexts.tryRegister({
        id: "notes",
        aliases: ["note"],
        description: "Saved notes",
      });
      h.runtime.actions.length = 0;
      const executed: string[] = [];
      for (const name of ["NOTES_LIST", "CALENDAR_FEED", "CALENDAR_NEXT_EVENT"])
        h.runtime.registerAction({
          name,
          description: name,
          contexts: name === "NOTES_LIST" ? ["notes"] : ["calendar"],
          validate: async () => true,
          handler: async () => {
            executed.push(name);
            return {
              success: true,
              data: {
                readOnlyOperation: true,
                count: name === "NOTES_LIST" && exists ? 1 : 0,
              },
            };
          },
        });
      h.runtime.registerResponseHandlerFieldEvaluator(calendarReadBindingField);
      h.runtime.responseHandlerEvaluators.push(calendarReadBindingEvaluator);
      let responseCalls = 0;
      h.runtime.registerModel(
        ModelType.RESPONSE_HANDLER,
        async () => {
          if (++responseCalls === 1) {
            const result = stageOneToolTurn();
            Object.assign(result.toolCalls[0].arguments, {
              intents: [
                "Read Notes to check whether a note exists",
                "If I have a note, read my next Calendar event",
              ],
              candidateActionNames: ["NOTES_LIST"],
              calendarReadBindings: [
                {
                  intentId: "intent:2",
                  operation: "next_event",
                  execution: "conditional",
                },
              ],
            });
            return result;
          }
          if (exists && executed.length === 1)
            return JSON.stringify({
              success: false,
              decision: "CONTINUE",
              thought:
                "A note exists, so perform the conditional next-event read.",
              requestFullyCovered: false,
              messageToUser: "",
            });
          return JSON.stringify({
            success: true,
            decision: "FINISH",
            thought: exists
              ? "Both requested reads finished."
              : "The condition is false, so no Calendar read is requested.",
            requestFullyCovered: true,
            outcomeCoverage: [
              {
                intentId: "intent:1",
                status: "completed",
                evidenceStepIds: ["step:1"],
              },
              {
                intentId: "intent:2",
                status: "completed",
                evidenceStepIds: [exists ? "step:2" : "step:1"],
              },
            ],
            messageToUser: exists
              ? "The conditional Calendar read completed."
              : "No note exists, so I skipped the Calendar read.",
          });
        },
        "conditional-read-test",
        200,
      );
      h.runtime.registerModel(
        ModelType.ACTION_PLANNER,
        async (_runtime, params) => {
          const tools = params.tools?.map((tool) => tool.name) ?? [];
          expect(tools).toContain("CALENDAR_NEXT_EVENT");
          expect(tools).not.toContain("CALENDAR_FEED");
          return {
            text: "",
            toolCalls: [
              {
                id: `read-${executed.length}`,
                name:
                  executed.length === 0 ? "NOTES_LIST" : "CALENDAR_NEXT_EVENT",
                arguments: {},
              },
            ],
          };
        },
        "conditional-read-test",
        200,
      );
      const message = {
        ...makeMessage(
          h.runtime,
          "If I have a note, read my next Calendar event.",
        ),
        id: "00000000-0000-0000-0000-000000000095" as UUID,
      };
      const outcome = await runV5MessageRuntimeStage1({
        runtime: h.runtime,
        message,
        state: await h.runtime.composeState(message),
        responseId: "00000000-0000-0000-0000-000000000096" as UUID,
        callback: h.callback,
      });
      expect(executed).toEqual(
        exists ? ["NOTES_LIST", "CALENDAR_NEXT_EVENT"] : ["NOTES_LIST"],
      );
      expect(outcome.kind).toBe("planned_reply");
      if (outcome.kind !== "planned_reply")
        throw new Error("Missing conditional reply");
      expect(outcome.result.responseContent?.text).toBe(
        exists
          ? "The conditional Calendar read completed."
          : "No note exists, so I skipped the Calendar read.",
      );
    },
  );

  it.each([
    {
      operation: "next_event",
      reader: "CALENDAR_NEXT_EVENT",
      text: "Open Notes and read my latest note and next Calendar event.",
    },
    {
      operation: "feed",
      reader: "CALENDAR_FEED",
      text: "Open Notes and read my latest note and Calendar agenda for next week.",
    },
  ] as const)(
    "routes the same-call typed $operation binding through the real planner surface",
    async ({ operation, reader, text }) => {
      const h = await createHarness({ actionResult: { success: true } });
      const world = await h.runtime.getWorld(h.runtime.agentId);
      if (!world) throw new Error("Missing owner world");
      await h.runtime.updateWorlds([
        {
          ...world,
          metadata: {
            ownership: { ownerId: USER_ID },
            roles: { [USER_ID]: "OWNER" },
          },
        },
      ]);
      h.runtime.contexts.tryRegister({
        id: "notes",
        aliases: ["note"],
        description: "Saved notes",
      });
      h.runtime.actions.length = 0;
      const executed: string[] = [];
      for (const name of [
        "VIEWS_SHOW",
        "NOTES_LIST",
        "CALENDAR_FEED",
        "CALENDAR_NEXT_EVENT",
      ]) {
        h.runtime.registerAction({
          name,
          description: name,
          contexts: name === "NOTES_LIST" ? ["notes"] : ["general", "calendar"],
          validate: async () => true,
          handler: async () => {
            executed.push(name);
            return { success: true, data: { readOnlyOperation: true } };
          },
        });
      }
      h.runtime.registerResponseHandlerFieldEvaluator(calendarReadBindingField);
      h.runtime.responseHandlerEvaluators.push({
        name: "host.view-navigation",
        priority: 60,
        shouldRun: () => true,
        evaluate: () => ({
          requiresTool: true,
          addCandidateActions: ["VIEWS_SHOW"],
          addContextSlices: [
            "Navigation target is the current-request registered Notes view.",
          ],
        }),
      });
      h.runtime.responseHandlerEvaluators.push(calendarReadBindingEvaluator);
      const intents = [
        "Open Notes view",
        "Read latest note",
        operation === "next_event"
          ? "Read next calendar event"
          : "Read Calendar agenda for next week",
      ];
      let responseCalls = 0;
      h.runtime.registerModel(
        ModelType.RESPONSE_HANDLER,
        async () => {
          if (++responseCalls === 1) {
            const result = stageOneToolTurn();
            Object.assign(result.toolCalls[0].arguments, {
              intents,
              candidateActionNames: ["CALENDAR_FEED"],
              calendarReadBindings: [
                { intentId: "intent:3", operation, execution: "required" },
              ],
            });
            return result;
          }
          return JSON.stringify({
            success: false,
            decision: "FINISH",
            thought: "This surface test stops after the selected read.",
            requestFullyCovered: false,
            messageToUser: "Only the selected Calendar read was exercised.",
          });
        },
        "typed-read-test",
        200,
      );
      h.runtime.registerModel(
        ModelType.ACTION_PLANNER,
        async (_runtime, params) => {
          const names = params.tools?.map((tool) => tool.name) ?? [];
          expect(names).toContain("VIEWS_SHOW");
          expect(names).toContain("NOTES_LIST");
          expect(names).toContain(reader);
          expect(names).not.toContain(
            operation === "next_event"
              ? "CALENDAR_FEED"
              : "CALENDAR_NEXT_EVENT",
          );
          for (const intent of intents)
            expect(JSON.stringify(params.messages)).toContain(intent);
          return {
            text: "",
            toolCalls: [{ id: "selected-read", name: reader, arguments: {} }],
          };
        },
        "typed-read-test",
        200,
      );
      const message = {
        ...makeMessage(h.runtime, text),
        id: "00000000-0000-0000-0000-000000000094" as UUID,
      };
      const outcome = await runV5MessageRuntimeStage1({
        runtime: h.runtime,
        message,
        state: await h.runtime.composeState(message),
        responseId: "00000000-0000-0000-0000-000000000093" as UUID,
        callback: h.callback,
      });
      expect(outcome.kind).toBe("planned_reply");
      expect(executed).toEqual([reader]);
      expect(responseCalls).toBe(2);
    },
  );

  it("terminates with the honest partial reply when FINISH admits a blocked outcome", async () => {
    const h = await createHarness({
      actionResult: { success: true, data: { readOnlyOperation: true } },
    });
    const partial = "The read completed. I couldn't open the requested view.";
    let responseCalls = 0;
    h.runtime.registerModel(
      ModelType.RESPONSE_HANDLER,
      async () => {
        if (++responseCalls === 1) return stageOneToolTurn();
        return JSON.stringify({
          success: true,
          decision: "FINISH",
          thought: "The read completed, but navigation is blocked.",
          requestFullyCovered: true,
          outcomeCoverage: [
            {
              intentId: "intent:1",
              status: "completed",
              evidenceStepIds: ["step:1"],
            },
            {
              intentId: "intent:2",
              status: "blocked",
              evidenceStepIds: ["step:1"],
            },
          ],
          messageToUser: partial,
          replyEffectStatus: "none",
        });
      },
      "partial-finish-test",
      200,
    );
    h.runtime.registerModel(
      ModelType.ACTION_PLANNER,
      async () => plannerCalendarCall(),
      "partial-finish-test",
      200,
    );
    const outcome = await runV5MessageRuntimeStage1({
      runtime: h.runtime,
      message: makeMessage(h.runtime, "look up the requested entry"),
      state: { values: {}, data: {}, text: "" },
      responseId: "00000000-0000-0000-0000-000000000083" as UUID,
      callback: h.callback,
    });
    expect(outcome.kind).toBe("planned_reply");
    if (outcome.kind !== "planned_reply")
      throw new Error("Missing planned reply");
    expect(outcome.result.responseContent?.text).toBe(partial);
    expect(responseCalls).toBe(2);
  });

  it.each(["VIEWS", "VIEWS_SHOW"])(
    "preserves host-added %s through mixed Notes/Calendar owner-read narrowing",
    async (navigationName) => {
      const h = await createHarness({ actionResult: { success: true } });
      h.runtime.contexts.tryRegister({
        id: "notes",
        aliases: ["note"],
        description: "Saved notes",
      });
      const world = await h.runtime.getWorld(h.runtime.agentId);
      if (!world) throw new Error("Missing caller world");
      await h.runtime.updateWorlds([
        {
          ...world,
          metadata: {
            ownership: { ownerId: USER_ID },
            roles: { [USER_ID]: "OWNER" },
          },
        },
      ]);
      h.runtime.actions.length = 0;
      const executed: string[] = [];
      for (const name of [
        navigationName,
        "NOTES_LIST",
        "CALENDAR_FEED",
        "CALENDAR_DELETE_EVENT",
      ]) {
        h.runtime.registerAction({
          name,
          description: name === navigationName ? "Open Notes view" : name,
          parameters:
            name === navigationName
              ? [
                  {
                    name: "view",
                    description: "Registered destination",
                    required: true,
                    schema: { type: "string" },
                  },
                  {
                    name: "navigationStepId",
                    description: "Runtime-owned navigation correlation",
                    required: false,
                    schema: { type: "string" },
                  },
                ]
              : [],
          contexts:
            name === navigationName
              ? ["general", "notes", "calendar"]
              : name === "NOTES_LIST"
                ? ["notes"]
                : ["calendar"],
          validate: async () => true,
          handler: async (_runtime, _message, _state, options) => {
            executed.push(name);
            if (name === navigationName)
              expect(options?.parameters?.view).toBe("notes");
            return { success: true, data: { readOnlyOperation: true } };
          },
        });
      }
      h.runtime.responseHandlerEvaluators.push({
        name: "host.view-navigation",
        priority: 60,
        shouldRun: () => true,
        evaluate: () => ({
          requiresTool: true,
          addContexts: ["general"],
          addCandidateActions: [navigationName],
          addContextSlices: [
            'Current-request navigation judgment: {"disposition":"planning","viewId":"notes"}. No navigation has executed.',
          ],
          clearReply: true,
        }),
      });
      const intents = [
        "Open the Notes view",
        "Read the latest note",
        "Look up the next calendar event",
      ];
      let stageOne = true;
      h.runtime.registerModel(
        ModelType.RESPONSE_HANDLER,
        async () => {
          if (stageOne) {
            stageOne = false;
            const output = stageOneToolTurn();
            output.toolCalls[0].arguments.intents = intents;
            output.toolCalls[0].arguments.candidateActionNames = [
              "CALENDAR_DELETE_EVENT",
            ];
            return output;
          }
          return JSON.stringify({
            success: true,
            decision: "FINISH",
            thought: "The requested work has settled.",
            messageToUser: "Read complete.",
            replyEffectStatus: "none",
          });
        },
        "mixed-navigation-test",
        200,
      );
      h.runtime.registerModel(
        ModelType.ACTION_PLANNER,
        async (_runtime, parameters) => {
          const names = parameters.tools?.map((tool) => tool.name) ?? [];
          expect(names).toContain(navigationName);
          expect(names).toContain("NOTES_LIST");
          expect(names).toContain("CALENDAR_FEED");
          expect(names).not.toContain("CALENDAR_DELETE_EVENT");
          const eventLine = parameters.messages
            ?.flatMap((message) =>
              typeof message.content === "string"
                ? message.content.split("\n")
                : [],
            )
            .find((line) => line.startsWith("message_handler: "));
          if (!eventLine) throw new Error("Missing routing event");
          const event = JSON.parse(eventLine.slice("message_handler: ".length));
          expect(event.content).toContain('"viewId":"notes"');
          expect(event.metadata.plan.intents).toEqual(intents);
          expect(event.metadata.plan.candidateActions).toEqual([
            navigationName,
            "CALENDAR_FEED",
          ]);
          return {
            text: "",
            toolCalls: [
              {
                id: "open-notes",
                name: navigationName,
                arguments: { view: "notes" },
              },
            ],
          };
        },
        "mixed-navigation-test",
        200,
      );
      const message = makeMessage(
        h.runtime,
        "Open Notes and read my latest note and next Calendar event.",
      );
      const outcome = await runV5MessageRuntimeStage1({
        runtime: h.runtime,
        message,
        state: await h.runtime.composeState(message),
        responseId: "00000000-0000-0000-0000-000000000083" as UUID,
        callback: h.callback,
      });
      expect(outcome.kind).toBe("planned_reply");
      expect(executed).toEqual([navigationName]);
    },
  );

  it.each([false, true])(
    "starts ambiguous read work with discovery and refreshes role (revoked=%s)",
    async (revoked) => {
      let calls = 0;
      const h = await createHarness({
        actionResult: {
          success: true,
          userFacingText: "Read complete.",
          verifiedUserFacing: true,
          turnComplete: true,
          data: { readOnlyOperation: true },
        },
        actionGate: async () => {
          calls++;
        },
      });
      const action = h.runtime.actions.find((entry) => entry.name === "LOOKUP");
      if (!action) throw new Error("Missing lookup");
      action.contexts = ["files"];
      action.roleGate = { minRole: "USER" };
      const request = "Read input.json without modifying the file";
      const stageOne = stageOneToolTurn("pending");
      stageOne.toolCalls[0].arguments.contexts = [];
      stageOne.toolCalls[0].arguments.intents = [request];
      stageOne.toolCalls[0].arguments.candidateActionNames = [];
      let handlerCalls = 0;
      h.runtime.registerModel(
        ModelType.RESPONSE_HANDLER,
        async () => {
          if (++handlerCalls === 1) return stageOne;
          return JSON.stringify({
            decision: "FINISH",
            thought: revoked
              ? "Discovery rejected the current role."
              : "The requested read completed.",
            success: !revoked,
            messageToUser: revoked
              ? "The current role cannot read that file."
              : "Read complete.",
          });
        },
        "bootstrap-discovery-test",
        300,
      );
      let plannerCalls = 0;
      h.runtime.registerModel(
        ModelType.ACTION_PLANNER,
        async (_runtime, params) => {
          const tools = (params.tools ?? []).map((tool) => tool.name);
          expect(JSON.stringify(params.messages ?? params.prompt)).toContain(
            request,
          );
          if (++plannerCalls === 1) {
            expect(tools).toContain("DISCOVER_ACTIONS");
            expect(tools).not.toContain("LOOKUP");
            if (revoked) {
              const freshWorld = await h.runtime.getWorld(h.runtime.agentId);
              if (!freshWorld) throw new Error("Missing current world");
              await h.runtime.updateWorlds([
                {
                  ...freshWorld,
                  metadata: {
                    ...freshWorld.metadata,
                    roles: { [USER_ID]: "GUEST" },
                  },
                },
              ]);
            }
            return {
              text: "",
              toolCalls: [
                {
                  id: "discover-files",
                  name: "DISCOVER_ACTIONS",
                  arguments: {
                    names: ["LOOKUP"],
                    eliza_turn_scope: "more_work_pending",
                  },
                },
              ],
            };
          }
          if (revoked) {
            expect(tools).not.toContain("LOOKUP");
            return {
              text: "The current role cannot read that file.",
              completed: true,
              toolCalls: [],
            };
          }
          expect(tools).toContain("LOOKUP");
          return {
            text: "",
            toolCalls: [
              {
                id: "read-file",
                name: "LOOKUP",
                arguments: { action: "verify", eliza_turn_scope: "final" },
              },
            ],
          };
        },
        "bootstrap-discovery-test",
        300,
      );
      const result = await new DefaultMessageService().handleMessage(
        h.runtime,
        makeMessage(h.runtime, request),
        h.callback,
      );
      expect(plannerCalls).toBe(2);
      expect(calls).toBe(revoked ? 0 : 1);
      if (revoked) {
        expect(result.actionResults).toEqual([
          expect.objectContaining({
            success: false,
            data: expect.objectContaining({ actionName: "DISCOVER_ACTIONS" }),
          }),
        ]);
      } else expect(result.responseContent?.text).toContain("Read complete");
    },
  );

  it("retains a failed public outcome when post-write replanning is throttled", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "planner-post-write-outage-"),
    );
    const path = join(directory, "result.txt");
    const content = "Exact original  output\nwith final newline.\n";
    let writes = 0;
    let evaluations = 0;
    let plans = 0;
    const failure = Object.assign(new Error("token quota exceeded"), {
      status: 429,
    });
    try {
      const h = await createHarness({
        evaluatorFailure: failure,
        onEvaluator: () => {
          evaluations++;
        },
        plannerCall: () => {
          if (++plans > 1) throw failure;
          return {
            ...plannerCalendarCall(),
            toolCalls: [
              {
                id: "write-once",
                name: "LOOKUP",
                arguments: {
                  action: "create",
                  eliza_turn_scope: "more_work_pending",
                },
              },
            ],
          };
        },
        actionGate: async () => {
          writes++;
          await writeFile(path, content);
        },
        actionResult: {
          success: true,
          userFacingText: "Saved the requested file.",
          verifiedUserFacing: true,
          turnComplete: true,
          effectReceipts: [
            {
              receiptId: "file-saved",
              operation: "file.write",
              outcome: "applied",
              resource: { kind: "file", id: path },
              artifacts: [],
              idempotency: { key: null, replayed: false },
              observedAt: "2026-09-26T00:00:00.000Z",
              commit: {
                kind: "durable",
                id: path,
                committedAt: "2026-09-26T00:00:00.000Z",
              },
            },
          ],
        },
      });
      const result = await new DefaultMessageService().handleMessage(
        h.runtime,
        makeMessage(
          h.runtime,
          "Save the entry, then verify it and report the final details.",
        ),
        h.callback,
      );
      expect(writes).toBe(1);
      expect(plans).toBe(2);
      expect(evaluations).toBe(0);
      expect(await readFile(path, "utf8")).toBe(content);
      expect(result.requestFulfilled).toBe(false);
      expect(result.outcome).toMatchObject({
        status: "failed",
        error: {
          code: "PLANNER_INCOMPLETE_PROVIDER_FAILURE",
          transient: false,
        },
        effects: [
          expect.objectContaining({
            receiptId: "file-saved",
            outcome: "applied",
          }),
        ],
      });
      expect(result.responseContent?.text).toContain(
        "Saved the requested file.",
      );
      expect(result.responseContent?.text).toContain(
        "request remains incomplete",
      );
      expect(visibleTexts(h.callbacks)).toEqual([result.responseContent?.text]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("delivers an honest partial outcome after evaluator throttling without replaying the completed action", async () => {
    let actionCalls = 0;
    let evaluatorCalls = 0;
    const planner = vi.fn(() => ({
      ...plannerCalendarCall(),
      toolCalls: [
        {
          id: "calendar-create-1",
          name: "LOOKUP",
          arguments: {
            action: "create",
            eliza_turn_scope: "more_work_pending",
          },
        },
      ],
    }));
    const h = await createHarness({
      evaluatorFailure: Object.assign(new Error("token quota exceeded"), {
        status: 429,
      }),
      onEvaluator: () => {
        evaluatorCalls++;
      },
      plannerCall: planner,
      actionResult: {
        success: true,
        userFacingText: USER_FACING,
        verifiedUserFacing: true,
        turnComplete: false,
        effectReceipts: [
          {
            receiptId: "calendar-saved",
            operation: "calendar.event.create",
            outcome: "applied",
            resource: { kind: "calendar.event", id: "event-1" },
            artifacts: [],
            idempotency: { key: null, replayed: false },
            observedAt: "2026-09-26T00:00:00.000Z",
            commit: {
              kind: "durable",
              id: "event-1",
              committedAt: "2026-09-26T00:00:00.000Z",
            },
          },
        ],
      },
      actionGate: async () => {
        actionCalls++;
      },
    });
    const result = await new DefaultMessageService().handleMessage(
      h.runtime,
      makeMessage(
        h.runtime,
        "Save the entry, then verify it and report the final details.",
      ),
      h.callback,
    );
    expect(actionCalls).toBe(1);
    expect(planner).toHaveBeenCalledTimes(1);
    expect(evaluatorCalls).toBe(1);
    expect(result.outcome).toMatchObject({
      status: "failed",
      error: { code: "PLANNER_INCOMPLETE_PROVIDER_FAILURE", transient: false },
      effects: [
        expect.objectContaining({
          receiptId: "calendar-saved",
          outcome: "applied",
        }),
      ],
    });
    expect(result.requestFulfilled).toBe(false);
    expect(result.responseContent?.text).toContain(USER_FACING);
    expect(result.responseContent?.text).toContain(
      "request remains incomplete",
    );
    expect(visibleTexts(h.callbacks)).toContain(result.responseContent?.text);
    expect(
      result.actionResults?.some((entry) =>
        entry.effectReceipts?.some(
          (receipt) => receipt.receiptId === "calendar-saved",
        ),
      ),
    ).toBe(true);
  });
  it.each([true, false])(
    "preserves an unexpected post-effect error as reply-only recovery without apology inference (result success=%s)",
    async (success) => {
      let actionCalls = 0;
      const h = await createHarness({
        actionResult: {
          success,
          transcriptVisibility: "internal",
          modelReplyRequired: true,
          data: { noteId: "note-1" },
          effectReceipts: [
            {
              receiptId: "saved-note-1",
              operation: "notes.note.create",
              outcome: "applied",
              resource: { kind: "note", id: "note-1" },
              artifacts: [],
              idempotency: { key: null, replayed: false },
              observedAt: "2026-09-14T00:00:00.000Z",
              commit: {
                kind: "durable",
                id: "note-1",
                committedAt: "2026-09-14T00:00:00.000Z",
              },
            },
          ],
        },
        actionGate: async () => {
          actionCalls++;
        },
      });
      const failure = new TypeError(
        "unexpected evaluator failure after commit",
      );
      let handlerCalls = 0;
      h.runtime.registerModel(
        ModelType.RESPONSE_HANDLER,
        async () => {
          if (handlerCalls++ === 0) return stageOneToolTurn();
          throw failure;
        },
        "post-effect-error-test",
        300,
      );
      const apologyModel = vi.fn(async () => {
        throw failure;
      });
      h.runtime.registerModel(
        ModelType.TEXT_SMALL,
        apologyModel,
        "post-effect-error-test",
        300,
      );
      const onSettledActionResult = vi.fn();
      const result = await new DefaultMessageService().handleMessage(
        h.runtime,
        makeMessage(h.runtime, "Save the note."),
        h.callback,
        { onSettledActionResult },
      );
      expect(result).toMatchObject({
        didRespond: false,
        responseContent: null,
        outcome: {
          status: "failed",
          error: {
            kind: "reply_generation_error",
            code: "POST_EFFECT_EVALUATION_FAILED",
            transient: false,
          },
        },
        replyRecovery: { pendingToolCalls: [] },
        actionResults: [
          expect.objectContaining({
            success,
            effectReceipts: [
              expect.objectContaining({
                receiptId: "saved-note-1",
                outcome: "applied",
              }),
            ],
          }),
        ],
      });
      expect(actionCalls).toBe(1);
      expect(onSettledActionResult).toHaveBeenCalledTimes(1);
      expect(onSettledActionResult).toHaveBeenCalledWith(
        expect.objectContaining({
          effectReceipts: [
            expect.objectContaining({
              receiptId: "saved-note-1",
              outcome: "applied",
            }),
          ],
        }),
      );
      expect(apologyModel).not.toHaveBeenCalled();
      expect(visibleTexts(h.callbacks)).toEqual([]);
    },
  );

  it("retains prior dialogue when immediate reply grounding needs a rewrite without replaying the tool", async () => {
    let actionCalls = 0;
    const h = await createHarness({
      actionResult: {
        success: true,
        text: "The live page heading is Example Domain.",
      },
      actionGate: async () => {
        actionCalls++;
      },
    });
    const history =
      "In this fictional story, Ada packs a cobalt notebook and a copper flask.";
    h.runtime.composeState = vi.fn(async () => ({
      values: { availableContexts: "general" },
      data: {
        providers: {
          RECENT_MESSAGES: {
            data: {
              recentMessages: [
                {
                  ...makeMessage(h.runtime, history),
                  id: "00000000-0000-4000-8000-000000000099",
                  createdAt: 1,
                },
              ],
            },
          },
        },
      },
      text: "",
    })) as AgentRuntime["composeState"];
    let handlerCalls = 0;
    h.runtime.registerModel(
      ModelType.RESPONSE_HANDLER,
      async () => {
        if (handlerCalls++ === 0) return stageOneToolTurn();
        return JSON.stringify({
          thought: "The read succeeded; answer the compound request.",
          success: true,
          decision: "FINISH",
          messageToUser:
            "Cancelled the note edit. The page heading is Example Domain.",
        });
      },
      "inline-recovery-context-test",
      300,
    );
    let rewriteCalls = 0;
    let reviewCalls = 0;
    const answer =
      "I will not perform the edit. The page heading is Example Domain. Ada packs a cobalt notebook and a copper flask.";
    h.runtime.registerModel(
      ModelType.TEXT_SMALL,
      async (_runtime, params) => {
        if (params.prompt.startsWith("Review recovered reply grounding.")) {
          reviewCalls++;
          expect(params.prompt).toContain(history);
          expect(params.prompt).toContain(
            "The live page heading is Example Domain.",
          );
          return JSON.stringify({
            grounded: true,
            completedChangeClaim: false,
            reason:
              "The read result and original fictional history support the reply; no edit is claimed.",
          });
        }
        rewriteCalls++;
        expect(params.prompt).toContain(history);
        expect(params.prompt).toContain(
          "The live page heading is Example Domain.",
        );
        return JSON.stringify({ response: answer, effectReceiptIds: [] });
      },
      "inline-recovery-context-test",
      300,
    );
    const result = await new DefaultMessageService().handleMessage(
      h.runtime,
      makeMessage(
        h.runtime,
        "Withdraw the unstarted note edit, look up the live page heading, and recall Ada's fictional packing list. Do not change any records.",
      ),
      h.callback,
    );
    expect(actionCalls).toBe(1);
    expect(rewriteCalls).toBe(1);
    expect(reviewCalls).toBe(1);
    expect(result.responseContent?.text).toBe(answer);
  });

  beforeEach(() => {
    vi.stubEnv("ELIZA_TRAJECTORY_LOGGING", "0");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      activeRuntimes.splice(0).map(async (runtime) => {
        await runtime.stop();
        await runtime.close();
      }),
    );
  });

  it("propagates out-of-band Stop instead of rescuing settled tool text", async () => {
    let announce!: (roomId: UUID) => void;
    const entered = new Promise<UUID>((resolve) => {
      announce = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = await createHarness({
      actionResult: {
        success: true,
        userFacingText: USER_FACING,
        modelReplyRequired: true,
      },
      actionGate: async (roomId) => {
        announce(roomId);
        await gate;
      },
    });
    const pending = new DefaultMessageService().handleMessage(
      harness.runtime,
      makeMessage(harness.runtime, "look up the eliza-test entry"),
      harness.callback,
      { onStreamChunk: async () => undefined },
    );
    const rejection = expect(pending).rejects.toMatchObject({
      code: "TURN_ABORTED",
    });
    const roomId = await entered;
    expect(
      harness.runtime.turnControllers.abortTurn(roomId, "ui-chat-stop"),
    ).toBe(true);
    release();
    await rejection;
    expect(visibleTexts(harness.callbacks)).toEqual([]);
    expect(harness.reportedScopes).not.toContain("MessageService.plannerLoop");
  });

  it("never delivers the preliminary navigation promise after Stop during planning", async () => {
    let announce!: () => void;
    const entered = new Promise<void>((resolve) => {
      announce = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let actionCalls = 0;
    const harness = await createHarness({
      actionResult: { success: true },
      actionGate: async () => {
        actionCalls++;
      },
    });
    const stageOne = stageOneToolTurn();
    stageOne.toolCalls[0].arguments.replyText =
      "Switching you to the calendar view now.";
    harness.runtime.responseHandlerEvaluators.push({
      name: "navigation-planning-admission",
      priority: 100,
      shouldRun: () => true,
      evaluate: () => ({ reply: "On it.", requiresTool: true }),
    });
    harness.runtime.registerModel(
      ModelType.RESPONSE_HANDLER,
      async () => stageOne,
      "stop-test",
      200,
    );
    harness.runtime.registerModel(
      ModelType.ACTION_PLANNER,
      async () => {
        announce();
        await gate;
        throw new Error("provider stopped after cancellation");
      },
      "stop-test",
      200,
    );
    const pending = new DefaultMessageService().handleMessage(
      harness.runtime,
      makeMessage(harness.runtime, "look up the requested entry"),
      harness.callback,
    );
    const rejection = expect(pending).rejects.toMatchObject({
      code: "TURN_ABORTED",
    });
    await entered;
    const [roomId] = harness.runtime.turnControllers.activeRoomIds();
    expect(roomId).toBeDefined();
    expect(
      harness.runtime.turnControllers.abortTurn(roomId, "ui-chat-stop"),
    ).toBe(true);
    release();
    await rejection;
    expect(actionCalls).toBe(0);
    expect(visibleTexts(harness.callbacks)).toEqual([]);
    expect(harness.reportedScopes).not.toContain("MessageService.plannerLoop");
  });

  it("preserves partial settlements when an explicit tool-call budget stops a batch", async () => {
    const savedItems: number[] = [];
    let apologyCalls = 0;
    const harness = await createHarness({
      actionResult: {
        success: true,
        text: "Item saved.",
        data: { userFacingText: "Item saved." },
      },
    });
    harness.runtime.registerModel(
      ModelType.TEXT_LARGE,
      async () => {
        apologyCalls++;
        return "Nothing was completed.";
      },
      "limit-test",
      200,
    );
    harness.runtime.actions[0].handler = async (
      _runtime,
      _message,
      _state,
      options,
    ) => {
      const item = options?.parameters?.item;
      if (typeof item !== "number") throw new Error("Missing requested item");
      savedItems.push(item);
      return {
        success: true,
        text: "Item saved.",
        data: { userFacingText: "Item saved.", item },
      };
    };
    harness.runtime.actions[0].parameters?.push({
      name: "item",
      description: "Distinct requested item",
      required: true,
      schema: { type: "number" },
    });
    let stageOne = true;
    harness.runtime.registerModel(
      ModelType.RESPONSE_HANDLER,
      async () => {
        if (stageOne) {
          stageOne = false;
          return stageOneToolTurn();
        }
        return JSON.stringify({
          success: true,
          decision: "NEXT_RECOMMENDED",
          thought: "The remaining distinct entries still need saving.",
          recommendedToolCallId: `save-${savedItems.length}`,
        });
      },
      "limit-test",
      200,
    );
    harness.runtime.registerModel(
      ModelType.TEXT_SMALL,
      async () => {
        return "The tool-call budget was reached before all requested entries could be saved.";
      },
      "limit-test",
      200,
    );
    harness.runtime.registerModel(
      ModelType.ACTION_PLANNER,
      async () => ({
        text: "",
        toolCalls: Array.from({ length: 17 }, (_, i) => ({
          id: `save-${i}`,
          name: "LOOKUP",
          arguments: { action: "create", item: i },
        })),
      }),
      "limit-test",
      200,
    );
    const message = makeMessage(
      harness.runtime,
      "Save all seventeen distinct requested entries in order.",
    );
    const settled: ActionResult[] = [];
    const outcome = await runV5MessageRuntimeStage1({
      runtime: harness.runtime,
      message,
      state: await harness.runtime.composeState(message),
      responseId: "00000000-0000-0000-0000-000000000083" as UUID,
      callback: harness.callback,
      plannerLoopConfig: { maxToolCalls: 16 },
      onSettledActionResult: (result) => {
        settled.push(result);
      },
    });
    expect(savedItems).toEqual(Array.from({ length: 16 }, (_, i) => i));
    expect(settled).toHaveLength(16);
    expect(settled.map((result) => result.data?.item)).toEqual(savedItems);
    expect(apologyCalls).toBe(0);
    expect(outcome.kind).toBe("planned_reply");
    if (outcome.kind !== "planned_reply")
      throw new Error("Expected planned result");
    expect(outcome.result.terminalFailure).toMatchObject({
      kind: "resource_limit",
      transient: false,
    });
    expect(outcome.result.responseContent?.text).toContain(
      "before the request was complete",
    );
    expect(visibleTexts(harness.callbacks).join(" ")).not.toContain(
      "Nothing was completed",
    );
    expect(visibleTexts(harness.callbacks)).not.toContain("Item saved.");
  });

  it.each([
    { boundary: "stage-one proposal review", settled: false, proposed: true },
    { boundary: "planner", settled: false, proposed: false },
    { boundary: "post-tool evaluation", settled: true, proposed: false },
  ])(
    "preserves the complete provider context at $boundary",
    async ({ settled, proposed }) => {
      let actionCalls = 0;
      const harness = await createHarness({
        actionResult: {
          success: true,
          text: USER_FACING,
          data: { userFacingText: USER_FACING },
        },
        actionGate: async () => {
          actionCalls++;
        },
      });
      const stageOne = stageOneToolTurn("non_applied");
      const preliminary =
        "Setting it up: 25 pushups, 3 a day, no fixed times, counted whenever you get them in.";
      stageOne.toolCalls[0].arguments.replyText = proposed ? preliminary : "";
      const overflow = new ElizaError(
        "Complete planner request exceeds provider capacity",
        {
          code: PROVIDER_CONTEXT_OVERFLOW,
          context: { requestedTokens: 177751, limit: 131072 },
        },
      );
      harness.runtime.registerModel(
        ModelType.TEXT_SMALL,
        async () => {
          throw overflow;
        },
        "overflow-test",
        200,
      );
      let stageCalls = 0;
      harness.runtime.registerModel(
        ModelType.RESPONSE_HANDLER,
        async (_runtime, params) => {
          if (stageCalls++ === 0) return stageOne;
          expect(JSON.stringify(params)).toContain(completeRequest);
          throw overflow;
        },
        "overflow-test",
        200,
      );
      const completeRequest =
        "look up the requested entry " +
        "complete background context ".repeat(600) +
        "END-OF-COMPLETE-REQUEST";
      let plannerCalls = 0;
      harness.runtime.registerModel(
        ModelType.ACTION_PLANNER,
        async (_runtime, params) => {
          plannerCalls++;
          expect(JSON.stringify(params)).toContain(completeRequest);
          if (settled) return plannerCalendarCall();
          throw overflow;
        },
        "overflow-test",
        200,
      );
      await new DefaultMessageService().handleMessage(
        harness.runtime,
        makeMessage(harness.runtime, completeRequest),
        harness.callback,
      );
      // A Stage-1 reply proposal is reviewed before planning. Without a
      // proposal, planner overflow prevents dispatch; post-tool overflow
      // preserves the settled receipt without delivering an unchecked reply.
      expect(plannerCalls).toBe(proposed ? 0 : 1);
      expect(stageCalls).toBeGreaterThan(1);
      expect(actionCalls).toBe(settled ? 1 : 0);
      expect(harness.callbacks).toContainEqual(
        expect.objectContaining({
          failureKind: "context_overflow",
          transient: false,
        }),
      );
      expect(visibleTexts(harness.callbacks)).not.toContain(preliminary);
      expect(visibleTexts(harness.callbacks)).not.toContain(USER_FACING);
    },
  );

  it.each(["evaluation", "settlement", "internal settlement"])(
    "preserves settled evidence when %s throws an arbitrary error",
    async (boundary) => {
      const directory = await mkdtemp(join(tmpdir(), "planner-handler-error-"));
      const path = join(directory, "record.txt");
      const content = "Full original contents\nwith another line.\n";
      try {
        const h = await createHarness({
          actionResult: { success: true },
          evaluatorFailure: new Error("private programmer diagnostic"),
          plannerCall: () => ({
            ...plannerCalendarCall(),
            toolCalls: [
              {
                id: "write-once",
                name: "LOOKUP",
                arguments: { action: "create", eliza_turn_scope: "final" },
              },
              {
                id: "read-once",
                name: "LOOKUP",
                arguments: { action: "verify", eliza_turn_scope: "final" },
              },
            ],
          }),
        });
        if (boundary !== "evaluation") {
          const emitEvent = h.runtime.emitEvent.bind(h.runtime);
          h.runtime.emitEvent = ((event, payload) => {
            if (event === EventType.ACTION_COMPLETED)
              throw new Error("private event-dispatch programmer diagnostic");
            return emitEvent(event, payload);
          }) as AgentRuntime["emitEvent"];
        }
        const action = h.runtime.actions.find(
          (entry) => entry.name === "LOOKUP",
        );
        if (!action) throw new Error("Missing test action");
        const executed: string[] = [];
        action.handler = async (_runtime, _message, _state, options) => {
          const operation = String(options?.parameters?.action);
          executed.push(operation);
          if (operation === "verify") {
            return {
              success: true,
              text: "private read diagnostic",
              data: { contents: await readFile(path, "utf8") },
            };
          }
          await writeFile(path, content);
          return {
            success: true,
            userFacingText:
              boundary === "internal settlement"
                ? "private internal result"
                : "Saved the requested file.",
            ...(boundary === "internal settlement"
              ? { transcriptVisibility: "internal" as const }
              : {}),
            verifiedUserFacing: true,
            turnComplete: true,
            effectReceipts: [
              {
                receiptId: "generic-error-file-saved",
                operation: "file.write",
                outcome: "applied",
                resource: { kind: "file", id: path },
                artifacts: [],
                idempotency: { key: null, replayed: false },
                observedAt: "2026-09-26T00:00:00.000Z",
                commit: {
                  kind: "durable",
                  id: path,
                  committedAt: "2026-09-26T00:00:00.000Z",
                },
              },
            ],
          };
        };
        const result = await new DefaultMessageService().handleMessage(
          h.runtime,
          makeMessage(
            h.runtime,
            "Write the file, then read it and report its contents.",
          ),
          h.callback,
        );
        expect(executed).toEqual(
          boundary === "evaluation" ? ["create", "verify"] : ["create"],
        );
        expect(await readFile(path, "utf8")).toBe(content);
        expect(result.requestFulfilled).toBe(false);
        expect(result.outcome).toMatchObject({
          status: "failed",
          error: {
            kind: "handler_error",
            code: "PLANNER_INTERRUPTED_AFTER_ACTION",
          },
          effects: [
            expect.objectContaining({ receiptId: "generic-error-file-saved" }),
          ],
        });
        expect(result.actionResults).toHaveLength(
          boundary === "evaluation" ? 2 : 1,
        );
        if (boundary === "evaluation") {
          expect(result.actionResults?.[1]?.data).toMatchObject({
            contents: content,
          });
          expect(result.responseContent?.text).toContain(
            "Saved the requested file.",
          );
        }
        expect(result.responseContent?.text).toContain(
          "request remains incomplete",
        );
        expect(result.responseContent?.text).not.toContain("private");
        expect(visibleTexts(h.callbacks)).toEqual([
          result.responseContent?.text,
        ]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("delivers the completed tool's user-facing result instead of the canned failure", async () => {
    const harness = await createHarness({
      actionResult: {
        success: true,
        text: DIAGNOSTIC,
        userFacingText: USER_FACING,
        verifiedUserFacing: true,
      },
    });

    const result = await new DefaultMessageService().handleMessage(
      harness.runtime,
      makeMessage(harness.runtime, "look up the eliza-test entry"),
      harness.callback,
    );

    expect(result.responseContent?.text).toContain(USER_FACING);
    expect(result.responseContent?.text).toContain(
      "request remains incomplete",
    );
    expect(result.requestFulfilled).toBe(false);
    expect(result.outcome).toMatchObject({
      status: "failed",
      error: { kind: "handler_error" },
    });
    const delivered = visibleTexts(harness.callbacks);
    expect(delivered).toContain(result.responseContent?.text);
    // The canned transient/rate-limit apology must not replace a result the
    // turn already produced.
    for (const text of delivered) {
      expect(text.toLowerCase()).not.toContain("rate-limit");
      expect(text.toLowerCase()).not.toContain("something went wrong");
      expect(text).not.toContain(DIAGNOSTIC);
    }
    // The loop failure is still reported — the rescue is a degrade, not a
    // success mask.
    expect(harness.reportedScopes).toContain("MessageService.plannerLoop");
  });

  it.each([ChannelType.DM, ChannelType.VOICE_DM])(
    "does not replay work or rescue an older success after failed verification and provider throttling on %s",
    async (channelType) => {
      const harness = await createHarness({ actionResult: { success: true } });
      const action = harness.runtime.actions.find(
        (entry) => entry.name === "LOOKUP",
      );
      if (!action) throw new Error("Lookup action missing from harness");

      const executed: string[] = [];
      action.handler = async (_runtime, _message, _state, options) => {
        const operation = options?.parameters?.action;
        if (typeof operation !== "string") throw new Error("Missing operation");
        executed.push(operation);
        return operation === "create"
          ? {
              success: true,
              userFacingText: USER_FACING,
              verifiedUserFacing: true,
            }
          : {
              success: false,
              text: "Verification lookup did not find the completed record.",
              userFacingText:
                "Verification lookup did not find the completed record.",
              verifiedUserFacing: true,
              turnComplete: true,
              data: { readOnlyOperation: true },
            };
      };
      let responseCalls = 0;
      harness.runtime.registerModel(
        ModelType.RESPONSE_HANDLER,
        async () => {
          if (++responseCalls === 1) return stageOneToolTurn();
          return JSON.stringify({
            decision: "CONTINUE",
            success: executed.length < 2,
            thought: "Continue with the remaining requested read.",
          });
        },
        "failed-verification-test",
        200,
      );
      let plannerCalls = 0;
      harness.runtime.registerModel(
        ModelType.ACTION_PLANNER,
        async () => {
          ++plannerCalls;
          if (executed.length >= 2)
            throw Object.assign(
              new Error(
                "Too Many Requests: Tokens per minute limit exceeded - too many tokens processed.",
              ),
              { status: 429 },
            );
          return {
            text: "",
            completed: false,
            toolCalls: [
              {
                id: `entry-${plannerCalls}`,
                name: "LOOKUP",
                arguments: {
                  action: executed.length === 0 ? "create" : "verify",
                },
              },
            ],
          };
        },
        "failed-verification-test",
        200,
      );
      const message = makeMessage(
        harness.runtime,
        "Create the entry, verify it, then read the final calendar.",
      );
      message.content.channelType = channelType;
      const result = await new DefaultMessageService().handleMessage(
        harness.runtime,
        message,
        harness.callback,
      );
      expect(executed).toEqual(["create", "verify"]);
      expect(visibleTexts(harness.callbacks)).not.toContain(USER_FACING);
      expect(result.responseContent?.text).not.toBe(USER_FACING);
      expect(result.responseContent?.text).toBe(
        "Verification lookup did not find the completed record.",
      );
    },
  );

  it("reports incomplete work without exposing diagnostic-only results", async () => {
    const harness = await createHarness({
      actionResult: {
        success: true,
        text: DIAGNOSTIC,
      },
    });

    const result = await new DefaultMessageService().handleMessage(
      harness.runtime,
      makeMessage(harness.runtime, "look up the eliza-test entry"),
      harness.callback,
    );

    const delivered = visibleTexts(harness.callbacks);
    expect(delivered.length).toBeGreaterThan(0);
    // Diagnostic tool text remains evidence, never assistant prose.
    expect(delivered.join("\n")).toContain("request remains incomplete");
    expect(result.outcome).toMatchObject({
      status: "failed",
      error: { kind: "handler_error" },
    });
    expect(delivered.join("\n")).not.toContain(DIAGNOSTIC);
    expect(result.responseContent?.text ?? "").not.toContain(DIAGNOSTIC);
  });
});

describe("subAgentCompletionRelayBody parsing (#18208)", () => {
  const RELAY_HEADER =
    "[sub-agent: review pr 18175 (elizaos) — task_complete — this delegated task is DONE; the result is below, relay it to the user as the answer and do NOT start another sub-agent for it.]";
  const RESULT_BODY =
    "The PR fixes the pairing dead-end: hosts now redeem the in-progress pairing instead of dropping it. Two files changed, tests included.";

  it("extracts the result body from a task_complete relay", () => {
    expect(subAgentCompletionRelayBody(`${RELAY_HEADER}\n${RESULT_BODY}`)).toBe(
      RESULT_BODY,
    );
  });

  it("parses task_complete from a canonical header beyond character 400", () => {
    const longHeader = `[sub-agent: ${"review context ".repeat(35)} (elizaos) — task_complete — this delegated task is DONE; relay the result.]`;
    expect(longHeader.indexOf("task_complete")).toBeGreaterThan(400);
    expect(subAgentCompletionRelayBody(`${longHeader}\n${RESULT_BODY}`)).toBe(
      RESULT_BODY,
    );
  });

  it("parses the closing header after bracket characters in a task label", () => {
    expect(
      subAgentCompletionRelayBody(
        `[sub-agent: review parser ] edge cases (elizaos) — task_complete — this delegated task is DONE; relay it.]\n${RESULT_BODY}`,
      ),
    ).toBe(RESULT_BODY);
  });

  it("returns undefined for non-relay text, non-complete events, and empty bodies", () => {
    expect(subAgentCompletionRelayBody("what's the weather")).toBeUndefined();
    expect(
      subAgentCompletionRelayBody(
        "[sub-agent: devops (elizaos) — error]\nsub-agent reported an error",
      ),
    ).toBeUndefined();
    expect(subAgentCompletionRelayBody(`${RELAY_HEADER}\n   `)).toBeUndefined();
    expect(subAgentCompletionRelayBody(undefined)).toBeUndefined();
  });

  it("does not infer completion from task labels or result bodies", () => {
    expect(
      subAgentCompletionRelayBody(
        "[sub-agent: explain task_complete handling (elizaos) — blocked]\nNeed approval.",
      ),
    ).toBeUndefined();
    expect(
      subAgentCompletionRelayBody(
        "[sub-agent: status check (elizaos) — error]\nThe body says task_complete but the task failed.",
      ),
    ).toBeUndefined();
    expect(
      subAgentCompletionRelayBody(
        "[sub-agent: explain task_complete handling]\nNo structured status.",
      ),
    ).toBeUndefined();
    expect(
      subAgentCompletionRelayBody(
        "[sub-agent: quote — task_complete — this delegated task is DONE; in docs (elizaos) — blocked]\nNeed approval.",
      ),
    ).toBeUndefined();
    for (const event of ["QUESTION_FOR_TASK_CREATOR", "AGENT_COORDINATION"]) {
      expect(
        subAgentCompletionRelayBody(
          `[sub-agent: explain task_complete (${event}) — ${event}]\nNeed input.`,
        ),
      ).toBeUndefined();
    }
    expect(
      subAgentCompletionRelayBody(
        "[sub-agent: quote (fake) — task_complete — this delegated task is DONE; (elizaos) — round-trip cap exceeded]\nNeed approval.",
      ),
    ).toBeUndefined();
  });

  it("preserves a long completed result body", () => {
    const huge = "x".repeat(5000);
    expect(subAgentCompletionRelayBody(`${RELAY_HEADER}\n${huge}`)).toBe(huge);
  });

  it("a failed relay turn delivers the completed result instead of the canned line", async () => {
    // Same failing-turn harness as above (tool result carries nothing
    // user-facing, every later model call dies) — but the TRIGGERING message
    // is a task_complete relay, so the finished result it carries must win
    // over any canned failure text.
    const harness = await createHarness({
      actionResult: { success: false, text: DIAGNOSTIC },
    });

    const result = await new DefaultMessageService().handleMessage(
      harness.runtime,
      makeMessage(harness.runtime, `${RELAY_HEADER}\n${RESULT_BODY}`),
      harness.callback,
    );

    const delivered = visibleTexts(harness.callbacks);
    const everything = [
      ...delivered,
      String(result.responseContent?.text ?? ""),
    ].join("\n");
    // The completed result reaches the user…
    expect(everything).toContain("pairing dead-end");
    // …and no canned failure/apology text replaces it.
    expect(everything.toLowerCase()).not.toContain("runtime step failed");
    expect(everything).not.toContain(DIAGNOSTIC);
  });
});

describe("preservedSettledToolResult candidate selection", () => {
  const settle = (
    name: string,
    result: Partial<PlannerToolResult>,
  ): { name: string; result: PlannerToolResult } => ({
    name,
    result: { success: true, ...result } as PlannerToolResult,
  });

  it("picks the most recent successful non-terminal result with user-facing text", () => {
    const picked = preservedSettledToolResult(
      [
        settle("MEMORY_SEARCH", { userFacingText: "older answer" }),
        settle("LOOKUP", { userFacingText: USER_FACING }),
      ],
      new Set(),
    );
    expect(picked?.userFacingText).toBe(USER_FACING);
  });

  it("does not select an older successful operation past a failed verification", () => {
    expect(
      preservedSettledToolResult(
        [
          settle("LOOKUP", { userFacingText: USER_FACING }),
          settle("VERIFY", {
            success: false,
            userFacingText: "Verification failed.",
          }),
        ],
        new Set(),
      ),
    ).toBeUndefined();
  });

  it("retains a successful recovery after an earlier failed verification", () => {
    const recovered = preservedSettledToolResult(
      [
        settle("LOOKUP", {
          success: false,
          userFacingText: "Verification failed.",
        }),
        settle("LOOKUP", {
          success: true,
          userFacingText: "The saved entry is verified.",
        }),
      ],
      new Set(),
    );
    expect(recovered?.userFacingText).toBe("The saved entry is verified.");
  });

  it("skips failed results, terminals, and results without user-facing text", () => {
    expect(
      preservedSettledToolResult(
        [
          settle("LOOKUP", { success: false, userFacingText: "failed op" }),
          settle("REPLY", { userFacingText: "terminal reply text" }),
          settle("MEMORY_CREATE", { text: "Stored memory ev-1." }),
          settle("MEMORY_CREATE", { userFacingText: "   " }),
        ],
        new Set(),
      ),
    ).toBeUndefined();
  });

  it("skips a result the user already saw and falls back to an earlier one", () => {
    const deliveredNormalized = USER_FACING.replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    const picked = preservedSettledToolResult(
      [
        settle("MEMORY_SEARCH", { userFacingText: "undelivered answer" }),
        settle("LOOKUP", { userFacingText: USER_FACING }),
      ],
      new Set([deliveredNormalized]),
    );
    expect(picked?.userFacingText).toBe("undelivered answer");
  });

  it("returns undefined when everything eligible was already delivered", () => {
    const deliveredNormalized = USER_FACING.replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    expect(
      preservedSettledToolResult(
        [settle("LOOKUP", { userFacingText: USER_FACING })],
        new Set([deliveredNormalized]),
      ),
    ).toBeUndefined();
  });
});

describe("answerlessToolTurnReport", () => {
  const asyncAction: Action = {
    name: "TASKS",
    similes: ["TASKS_SPAWN_AGENT"],
    description: "Spawn a task.",
    asyncHandoff: true,
    validate: async () => true,
    handler: async () => ({ success: true }),
  };
  const settled = (
    result: Partial<PlannerToolResult>,
  ): Array<{ name: string; result: PlannerToolResult }> => [
    {
      name: "TASKS_SPAWN_AGENT",
      result: { success: true, ...result } as PlannerToolResult,
    },
  ];
  const report = (
    result: Partial<PlannerToolResult>,
    actionResult: ActionResult,
  ): string =>
    answerlessToolTurnReport({
      settledToolResults: settled(result),
      deliveredVisibleTexts: new Set(),
      actionResults: [actionResult],
      actions: [asyncAction],
      stageOneAck: "On it.",
    });

  it("never retains an ack for a failed async handoff", () => {
    expect(
      report(
        { success: false, text: "spawn failed" },
        { success: false, data: { actionName: "TASKS_SPAWN_AGENT" } },
      ),
    ).toBe("");
  });

  it("retains an ack only after applied acceptance proof", () => {
    expect(
      report(
        { success: true },
        {
          success: true,
          data: { actionName: "TASKS_SPAWN_AGENT" },
          effectReceipts: [
            {
              receiptId: "spawn-1",
              operation: "tasks.spawn_agent",
              outcome: "applied",
              resource: { kind: "acp.session", id: "session-1" },
              artifacts: [],
              idempotency: { key: null, replayed: false },
              observedAt: "2026-08-15T00:00:00.000Z",
              commit: {
                kind: "provider_accepted",
                id: "session-1",
                committedAt: "2026-08-15T00:00:00.000Z",
              },
            },
          ],
        },
      ),
    ).toBe("On it.");
  });

  it("preserves a verified failed outcome instead of a generic line", () => {
    const failure = "The coding task could not authenticate.";
    expect(
      report(
        {
          success: false,
          userFacingText: failure,
          verifiedUserFacing: true,
        },
        { success: false, data: { actionName: "TASKS_SPAWN_AGENT" } },
      ),
    ).toBe(failure);
  });

  it("does not trust an unverified failure projection", () => {
    expect(
      report(
        { success: false, userFacingText: "raw provider failure" },
        { success: false, data: { actionName: "TASKS_SPAWN_AGENT" } },
      ),
    ).toBe("");
  });
});

describe("answerlessToolTurnReport — structured effect receipts", () => {
  const viewsAction: Action = {
    name: "VIEWS",
    similes: [],
    description: "Switch the visible view.",
    validate: async () => true,
    handler: async () => ({ success: true }),
  };
  const report = (result: Partial<PlannerToolResult>): string =>
    answerlessToolTurnReport({
      settledToolResults: [
        {
          name: "VIEWS",
          result: { success: true, ...result } as PlannerToolResult,
        },
      ],
      deliveredVisibleTexts: new Set(),
      actionResults: [{ success: true, data: { actionName: "VIEWS" } }],
      actions: [viewsAction],
      stageOneAck: "",
    });

  it("leaves accepted effects without prose to model-backed recovery", () => {
    expect(
      report({
        text: JSON.stringify({
          effect: "view_navigation",
          status: "accepted",
          viewId: "chat",
          label: "Home",
          path: "/",
        }),
        transcriptVisibility: "internal",
      }),
    ).toBe("");
  });

  it("does not manufacture a reply for an empty success", () => {
    expect(report({})).toBe("");
  });

  it("preserves existing user-facing text", () => {
    expect(
      report({
        text: JSON.stringify({
          effect: "view_navigation",
          status: "accepted",
          label: "Home",
        }),
        userFacingText: "you're back on the home view.",
      }),
    ).toBe("you're back on the home view.");
  });
});
