/** Exact capture459 interpretation passes through both registered evaluator implementations. */
import {
  type Action,
  AgentRuntime,
  ContextRegistry,
  type Memory,
  type MessageHandlerResult,
  type RoleGateRole,
  registerDirectActionRoutingRule,
  runResponseHandlerEvaluators,
  stringToUuid,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { calendarReadBindingEvaluator } from "../../../../plugin-calendar/src/read-binding.ts";
import { briefAction } from "../../../../plugin-personal-assistant/src/actions/brief.ts";
import { createTrackedWorkRecapDirectRoutingRule } from "../../../../plugin-personal-assistant/src/lifeops/briefing/direct-routing.ts";
import { DEFAULT_CONTEXT_DEFINITIONS } from "../../runtime/default-contexts.ts";
import { BUILTIN_RESPONSE_HANDLER_EVALUATORS } from "./stage1-evaluators.ts";

const request =
  "Give me my daily dossier using the connected sources available now.";
const rawContexts = [
  "productivity",
  "calendar",
  "tasks",
  "todos",
  "email",
  "notes",
];
const rawIntent =
  "Compile today's daily dossier from connected sources (calendar, tasks/todos, email, notes)";
const direct = BUILTIN_RESPONSE_HANDLER_EVALUATORS.find(
  (evaluator) => evaluator.name === "core.direct_registered_capability_request",
);
if (!direct) throw new Error("Direct-route evaluator is not registered");

function fixture(text = request, action: Partial<Action> | null = {}) {
  const runtime = new AgentRuntime({
    character: { name: "Owned outcome", bio: [] },
    logLevel: "fatal",
  });
  runtime.contexts = new ContextRegistry([...DEFAULT_CONTEXT_DEFINITIONS]);
  runtime.actions =
    action === null
      ? []
      : [{ ...briefAction, validate: async () => true, ...action }];
  registerDirectActionRoutingRule(
    runtime,
    createTrackedWorkRecapDirectRoutingRule(),
  );
  const message: Memory = {
    id: stringToUuid("scope-message"),
    agentId: runtime.agentId,
    roomId: stringToUuid("scope-room"),
    entityId: stringToUuid("scope-owner"),
    createdAt: 1000,
    content: { text },
  };
  const handler: MessageHandlerResult = {
    processMessage: "RESPOND",
    thought: "",
    plan: {
      contexts: [...rawContexts],
      intents: [rawIntent],
      replyEffectStatus: "pending",
      requiresTool: true,
      contextSlices: ["Retained authorized context"],
      calendarReadBindings: [
        {
          intentId: "intent:1",
          operation: "feed",
          execution: "required",
          sourceMessageId: String(message.id),
          roomId: message.roomId,
          actorId: message.entityId,
          requestedAt: 1000,
        },
      ],
    },
  };
  return {
    runtime,
    message,
    messageHandler: handler,
    state: { values: {}, data: {}, text: "" },
    availableContexts: [...DEFAULT_CONTEXT_DEFINITIONS],
    userRoles: ["OWNER"] as RoleGateRole[],
  };
}

describe("whole-request composite reconciliation", () => {
  it.each([undefined, ["CALENDAR_FEED"]])(
    "reconciles exact459 before Calendar adds its derived requirement (%j)",
    async (candidates) => {
      const args = fixture();
      args.messageHandler.plan.candidateActions = candidates;
      const original = structuredClone(args.message);
      const run = await runResponseHandlerEvaluators({
        ...args,
        evaluators: [calendarReadBindingEvaluator, direct],
      });
      expect(run.errors).toEqual([]);
      expect(args.messageHandler.plan.intents).toEqual([request]);
      expect(args.messageHandler.plan.contexts).toEqual([
        "productivity",
        "tasks",
      ]);
      expect(args.messageHandler.plan.candidateActions).toEqual(["BRIEF"]);
      expect(args.messageHandler.plan.calendarReadBindings).toBeUndefined();
      expect(args.messageHandler.plan.contextSlices).toEqual([
        "Retained authorized context",
      ]);
      expect(run.activeEvaluators).not.toContain("calendar.read-bindings");
      expect(args.message).toEqual(original);
    },
  );
  it.each([
    "; read my next Calendar event",
    "\nRead my next Calendar event",
    " and read my next Calendar event",
  ])("keeps an explicit independent Calendar request: %s", async (tail) => {
    const text = `Give me my daily dossier${tail}`;
    const args = fixture(text);
    args.messageHandler.plan.intents = [
      "Give me my daily dossier",
      "Read my next Calendar event",
    ];
    args.messageHandler.plan.calendarReadBindings = [
      {
        ...(args.messageHandler.plan.calendarReadBindings as object[])[0],
        intentId: "intent:2",
        operation: "next_event",
      },
    ];
    const before = structuredClone(args.messageHandler.plan);
    const run = await runResponseHandlerEvaluators({
      ...args,
      evaluators: [direct, calendarReadBindingEvaluator],
    });
    expect(run.errors).toEqual([]);
    expect(args.messageHandler.plan.intents).toEqual(before.intents);
    expect(args.messageHandler.plan.calendarReadBindings).toEqual(
      before.calendarReadBindings,
    );
    expect(args.messageHandler.plan.candidateActions).toContain(
      "CALENDAR_NEXT_EVENT",
    );
    expect(
      args.messageHandler.plan.contextSlices?.some((slice) =>
        slice.startsWith("Current-request Calendar read bindings:"),
      ),
    ).toBe(true);
  });
  it.each(["missing", "wrong-tags", "denied", "invalid"])(
    "leaves original derived scope unchanged when BRIEF admission is %s",
    async (mode) => {
      const args = fixture(
        request,
        mode === "missing"
          ? null
          : mode === "wrong-tags"
            ? { tags: ["domain:other"] }
            : mode === "invalid"
              ? { validate: async () => false }
              : {},
      );
      if (mode === "denied") args.userRoles = ["USER"];
      const before = structuredClone(args.messageHandler);
      const run = await runResponseHandlerEvaluators({
        ...args,
        evaluators: [direct],
      });
      expect(run.errors).toEqual([]);
      expect(args.messageHandler).toEqual(before);
    },
  );
  it("does not replace scope when two whole-request contracts collide", async () => {
    const args = fixture();
    registerDirectActionRoutingRule(args.runtime, {
      ...createTrackedWorkRecapDirectRoutingRule(),
      id: "test.second-whole-owner",
    });
    const before = structuredClone(args.messageHandler.plan);
    await runResponseHandlerEvaluators({ ...args, evaluators: [direct] });
    expect(args.messageHandler.plan.intents).toEqual(before.intents);
    expect(args.messageHandler.plan.calendarReadBindings).toEqual(
      before.calendarReadBindings,
    );
    expect(args.messageHandler.plan.contexts).toEqual(before.contexts);
  });
});
