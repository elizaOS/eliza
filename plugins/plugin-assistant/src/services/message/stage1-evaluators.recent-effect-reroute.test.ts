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
import { BUILTIN_RESPONSE_HANDLER_EVALUATORS } from "./stage1-evaluators.ts";

const agentId = "agent";
const roomId = "room";
const entityId = "owner";
const scope = `${agentId}:${roomId}:${entityId}`;
const actions: Action[] = [
  ...(calendarPlugin.actions ?? []),
  ownerRemindersAction,
];
const runtime = { agentId, actions } as unknown as IAgentRuntime;

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

async function reroute(recentMessages: Memory[]) {
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
    runtime,
    message: {
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
    } as Memory,
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
  it("plans in the calendar domain after a committed calendar create", async () => {
    const patch = await reroute([calendarCreate]);
    expect(patch?.requiresTool).toBe(true);
    expect(patch?.addCandidateActions).toBeUndefined();
    expect(patch?.addContexts).toContain("calendar");
    expect(patch?.addContexts).not.toContain("general");
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

  it("follows the newest committed reminder effect, not an older calendar one", async () => {
    const patch = await reroute([
      calendarCreate,
      priorRequest("reminder", 3, "remind me to stretch in 20 minutes", [
        {
          actionName: "OWNER_REMINDERS",
          success: true,
          effectReceipts: [
            receipt("reminder-create", "lifeops.owner.create", "applied"),
          ],
        },
      ]),
      // A later preview commits nothing and cannot become the referent.
      priorRequest("later-preview", 4, "draft lunch with Ana", [
        {
          actionName: "CALENDAR_CREATE_EVENT",
          success: true,
          effectReceipts: [
            receipt(
              "calendar-later-preview",
              "calendar.event.create",
              "preview",
            ),
          ],
        },
      ]),
    ]);
    expect(patch?.addContexts).toContain("tasks");
    // Only the older calendar create declares contacts.
    expect(patch?.addContexts).not.toContain("contacts");
  });
});
