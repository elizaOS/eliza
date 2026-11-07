/**
 * A simple reply that claims an applied change is rerouted to planning. A
 * referential follow-up ("move it to 4pm") has no wording of its own that
 * retrieval can match, so the reroute plans in the domains of the newest
 * committed effect in this room instead of the broad general surface (live
 * tj-786ca91739ceaa: general had no calendar tool and cost two discovery
 * rounds). Uses the registered calendar and reminder actions unchanged.
 */

import {
  type Action,
  ChannelType,
  conversationClientUserMemoryId,
  type IAgentRuntime,
  type Memory,
  type MessageHandlerResult,
  normalizeEffectReceipt,
  type State,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { calendarPlugin } from "../../../../plugin-calendar/src/plugin.ts";
import { ownerRemindersAction } from "../../../../plugin-personal-assistant/src/actions/owner-surfaces";
import { personalAssistantPlugin } from "../../../../plugin-personal-assistant/src/plugin.js";
import { retrieveContextualPlannerActions } from "./action-surface.js";
import { BUILTIN_RESPONSE_HANDLER_EVALUATORS } from "./stage1-evaluators.ts";

const agentId = "agent";
const roomId = "room";
const entityId = "owner";
const scope = `${agentId}:${roomId}:${entityId}`;
const leanActions: Action[] = [
  ...(calendarPlugin.actions ?? []),
  ownerRemindersAction,
];

const evaluator = BUILTIN_RESPONSE_HANDLER_EVALUATORS.find(
  (candidate) => candidate.name === "core.simple_completed_side_effect_claim",
);
if (!evaluator) throw new Error("side-effect claim evaluator is missing");

function receipt(
  receiptId: string,
  operation: string,
  outcome: "applied" | "preview",
) {
  const observedAt = "2026-10-30T11:01:00.896Z";
  return normalizeEffectReceipt({
    receiptId,
    operation,
    resource: {
      kind: operation.split(".").slice(0, -1).join("."),
      id: receiptId,
    },
    artifacts: [],
    idempotency: { key: receiptId, replayed: false },
    observedAt,
    outcome,
    ...(outcome === "applied"
      ? { commit: { kind: "durable", id: receiptId, committedAt: observedAt } }
      : {}),
  });
}

/** A prior client chat request with its durable recorded action outcome. */
function priorRequest(
  clientMessageId: string,
  createdAt: number,
  text: string,
  actionResults: unknown[],
): Memory {
  const id = conversationClientUserMemoryId(scope, clientMessageId);
  return {
    id,
    agentId,
    roomId,
    entityId,
    createdAt,
    content: {
      text,
      source: "client_chat",
      channelType: ChannelType.DM,
      chatIdempotency: {
        version: 1,
        scope,
        clientMessageId,
        fingerprint: "a".repeat(64),
        outcomeJson: JSON.stringify({ userMessageId: id, actionResults }),
      },
    },
  } as Memory;
}

const currentMessage = {
  id: "current",
  agentId,
  roomId,
  entityId,
  createdAt: 10,
  content: {
    text: "move it to 4pm",
    source: "client_chat",
    channelType: ChannelType.DM,
  },
} as Memory;

async function reroute(recentMessages: Memory[], actions = leanActions) {
  const messageHandler: MessageHandlerResult = {
    processMessage: "RESPOND",
    thought: "",
    plan: {
      contexts: ["simple"],
      reply:
        "Done. Coffee with Sam is now tomorrow, Saturday October 31, 4:00 to 5:00 pm.",
      replyEffectStatus: "applied",
    },
  };
  const context = {
    runtime: { agentId, actions } as unknown as IAgentRuntime,
    message: currentMessage,
    state: {
      values: {},
      data: { providers: { RECENT_MESSAGES: { data: { recentMessages } } } },
      text: "",
    } as State,
    messageHandler,
    availableContexts: [],
  };
  expect(await evaluator?.shouldRun(context)).toBe(true);
  return evaluator?.evaluate(context);
}

function reminderRequest(
  clientMessageId: string,
  createdAt: number,
  outcome: "applied" | "preview",
) {
  return priorRequest(
    clientMessageId,
    createdAt,
    "remind me to stretch in 20 minutes",
    [
      {
        actionName: "OWNER_REMINDERS",
        success: true,
        effectReceipts: [
          receipt(
            `${clientMessageId}-receipt`,
            "lifeops.owner.create",
            outcome,
          ),
        ],
      },
    ],
  );
}

const calendarCreate = priorRequest(
  "create",
  2,
  "add coffee with Sam tomorrow at 3pm",
  [
    {
      actionName: "CALENDAR_CREATE_EVENT",
      success: true,
      effectReceipts: [
        receipt("calendar-create", "calendar.event.create", "applied"),
      ],
    },
  ],
);

describe("simple applied-claim reroute without candidates", () => {
  it("plans only in the calendar domain the newest committed create owns", async () => {
    const patch = await reroute([
      reminderRequest("older-reminder", 1, "applied"),
      calendarCreate,
      // A later preview commits nothing and cannot become the referent.
      reminderRequest("later-preview", 4, "preview"),
    ]);
    expect(patch?.requiresTool).toBe(true);
    expect(patch?.addCandidateActions).toBeUndefined();
    // Not its incidental contacts/tasks contexts, and not the older reminder.
    expect(patch?.addContexts).toEqual(["calendar"]);
  });

  it("keeps the general fallback when no committed effect is recorded", async () => {
    const patch = await reroute([
      priorRequest("hello", 1, "hi", []),
      priorRequest("preview", 2, "draft a coffee with Sam", [
        {
          actionName: "CALENDAR_CREATE_EVENT",
          success: true,
          effectReceipts: [
            receipt("calendar-preview", "calendar.event.create", "preview"),
          ],
        },
      ]),
    ]);
    expect(patch?.addContexts).toEqual(["general"]);
  });

  it("follows the newest committed reminder effect into its task contexts", async () => {
    const patch = await reroute([
      calendarCreate,
      reminderRequest("reminder", 3, "applied"),
    ]);
    expect(patch?.addContexts).toContain("tasks");
  });

  it("starts the LifeOps planner on the calendar family, not every task family", async () => {
    const actions = personalAssistantPlugin.actions ?? [];
    const patch = await reroute([calendarCreate], actions);
    expect(patch?.addContexts).toEqual(["calendar"]);
    const initial = retrieveContextualPlannerActions({
      actions,
      deferUnscopedBootstrap: true,
      query: "move it to 4pm",
      message: currentMessage,
      intents: [],
      contexts: ["simple", ...(patch?.addContexts ?? [])],
    }).actions.map((action) => action.name);
    expect(initial).toContain("CALENDAR");
    expect(initial).not.toContain("OWNER_REMINDERS");
  });
});
