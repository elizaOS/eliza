/**
 * v613 (2026-11-18): with Contacts in front and chat full, "add an event called
 * v613 check tomorrow at 3pm" was refused ("the calendar tools are only
 * available while calendar is the registered context on this turn") and
 * "move v613 check to 4pm" then found nothing. The planner saw the open view's
 * routing hint ("active_contexts: contacts, general") and no Calendar
 * operation. From Browser or Home the same request created the event.
 *
 * These replay the Stage-1 decision through the real response-handler
 * evaluators and planner candidate admission with each phone view in front.
 * The renderer's chat presentation (full or sheet) is not part of the turn
 * metadata the agent receives, so one metadata shape covers both.
 */
import {
  AgentRuntime,
  attestAuthenticatedApiDeliveryAudience,
  getDirectActionRoutingRules,
  type Memory,
  promoteSubactionsToActions,
  runResponseHandlerEvaluators,
} from "@elizaos/core";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { viewsAction } from "../../../../../packages/agent/src/actions/views.ts";
import {
  closeRuntimeViewRegistry,
  registerBuiltinViews,
} from "../../../../../packages/agent/src/api/views-registry.ts";
import { registerViewNavigationRoutingRule } from "../../../../../packages/agent/src/runtime/view-navigation.ts";
import { mapsPlugin } from "../../../../plugin-maps/src/plugin.ts";
import { registerWorkflowRequestRouting } from "../../../../plugin-workflow/src/actions/workflow-request.ts";
import { uiContextProvider } from "../../features/basic-capabilities/providers/uiContext.ts";
import { DEFAULT_CONTEXT_DEFINITIONS } from "../../runtime/default-contexts.ts";
import {
  deviceActionTools,
  registerDeviceBrowserOpenRouting,
  registerDeviceCameraCaptureRouting,
  registerDeviceKeypadRouting,
  registerDeviceTelephonyRouting,
} from "../device-actions/tools.ts";
import { collectV5PlannerCandidateActions } from "./action-surface.ts";
import { listAvailableContextsForTurn } from "./context-catalog.ts";
import { BUILTIN_RESPONSE_HANDLER_EVALUATORS } from "./stage1-evaluators.ts";

Object.assign(globalThis, { React });
const {
  calendarPlugin,
  calendarEventRequest,
  registerCalendarEventRequestRouting,
} = await import("../../../../plugin-calendar/src/index.ts").then(
  async (index) => ({
    ...index,
    calendarPlugin: (await import("../../../../plugin-calendar/src/plugin.ts"))
      .calendarPlugin,
  }),
);
const { notesAction } = await import("../../../../plugin-notes/src/action.ts");

const owner = "11111111-1111-4111-8111-111111111111",
  room = "22222222-2222-4222-8222-222222222222";
const runtimes: AgentRuntime[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) closeRuntimeViewRegistry(runtime);
});

// What enrichChatUiViewMetadata attaches for each phone view in front.
const VIEWS = {
  contacts: {
    uiViewPath: "/contacts",
    primaryContext: "contacts",
    actions: [],
  },
  phone: { uiViewPath: "/phone", primaryContext: "phone", actions: [] },
  browser: {
    uiViewPath: "/browser",
    primaryContext: "browser",
    actions: ["BROWSER"],
  },
  maps: { uiViewPath: "/maps", primaryContext: "world", actions: [] },
  home: { uiViewPath: "/chat", primaryContext: "general", actions: [] },
} as const;
type View = keyof typeof VIEWS;

const CREATE = "add an event called v613 check tomorrow at 3pm";
const MOVE = "move v613 check to 4pm";
const REMOVE = "delete the calendar event v613 check";

/** The phone's actions and routes as v613 registers them. */
async function phoneFixture(text: string, view: View) {
  const runtime = new AgentRuntime({
    character: {
      name: "Eliza",
      bio: [],
      settings: { ELIZA_ADMIN_ENTITY_ID: owner },
    },
    logLevel: "fatal",
  });
  runtimes.push(runtime);
  runtime.contexts.tryRegisterMany(DEFAULT_CONTEXT_DEFINITIONS);
  vi.spyOn(runtime, "getRoom").mockResolvedValue({ worldId: "world" } as never);
  vi.spyOn(runtime, "getWorld").mockResolvedValue({
    id: "world",
    metadata: { roles: { [owner]: "OWNER" }, ownership: { ownerId: owner } },
  } as never);
  vi.spyOn(runtime, "getEntityById").mockResolvedValue(null);
  vi.spyOn(runtime, "getParticipantsForRoom").mockResolvedValue([
    owner,
    runtime.agentId,
  ]);
  for (const action of [
    ...(mapsPlugin.actions ?? []),
    ...(calendarPlugin.actions ?? []),
    ...promoteSubactionsToActions(notesAction),
    ...deviceActionTools,
    ...promoteSubactionsToActions(viewsAction),
  ])
    runtime.registerAction(action as never);
  registerBuiltinViews(runtime);
  registerViewNavigationRoutingRule(runtime);
  await mapsPlugin.init?.({}, runtime);
  registerDeviceCameraCaptureRouting(runtime);
  registerDeviceBrowserOpenRouting(runtime);
  registerDeviceTelephonyRouting(runtime);
  registerDeviceKeypadRouting(runtime);
  registerWorkflowRequestRouting(runtime);
  // What calendarPlugin.init registers for these requests.
  registerCalendarEventRequestRouting(runtime);
  const shape = VIEWS[view];
  const message = {
    id: "33333333-3333-4333-8333-333333333333",
    agentId: runtime.agentId,
    entityId: owner,
    roomId: room,
    content: {
      text,
      source: "client_chat",
      channelType: "DM",
      metadata: {
        viewClientId: "test-renderer",
        uiView: view === "home" ? "chat" : view,
        uiViewPath: shape.uiViewPath,
        uiViewCapabilities: [],
        uiViewActionNames: [...shape.actions],
        __responseContext: {
          primaryContext: shape.primaryContext,
          secondaryContexts: [],
        },
      },
    },
  } as Memory;
  await attestAuthenticatedApiDeliveryAudience(runtime, message, {
    kind: "owner_session",
    principalId: "fixture",
  });
  return { runtime, message };
}

/** Run the real evaluators over a Stage-1 plan, then admit the planner surface. */
async function replay(
  text: string,
  view: View,
  plan: Record<string, unknown>,
  processMessage = "RESPOND",
) {
  const { runtime, message } = await phoneFixture(text, view);
  const state = { text: "", values: {}, data: {} } as never;
  const availableContexts = await listAvailableContextsForTurn(
    runtime,
    message,
    state,
    "OWNER" as never,
  );
  const handler = {
    processMessage,
    plan: { parentActionHints: [], ...structuredClone(plan) } as Record<
      string,
      unknown
    > & {
      contexts: string[];
      candidateActions: string[];
      intents: string[];
    },
  };
  await runResponseHandlerEvaluators({
    runtime,
    message,
    state,
    messageHandler: handler,
    availableContexts,
    userRoles: ["OWNER"],
    evaluators: BUILTIN_RESPONSE_HANDLER_EVALUATORS,
  } as never);
  const surface = await collectV5PlannerCandidateActions({
    runtime,
    message,
    state,
    selectedContexts: handler.plan.contexts as never,
    candidateActions: handler.plan.candidateActions,
    intents: handler.plan.intents,
    userRoles: ["OWNER"] as never,
  });
  return {
    runtime,
    message,
    availableContexts: availableContexts.map((context) => context.id),
    plan: handler.plan,
    surface: surface.map((action) => action.name),
  };
}

// The Stage-1 shapes that leave Calendar off the planner surface.
const STAGE1_SHAPES = {
  // The v613 answer: a direct refusal with no tool.
  refusal: {
    contexts: ["simple"],
    intents: [],
    candidateActions: [],
    requiresTool: false,
    replyEffectStatus: "non_applied",
    reply:
      "I can't create that; the calendar tools are only available while calendar is the registered context on this turn.",
  },
  // The open view's context with no operation named.
  viewContext: {
    contexts: ["contacts"],
    intents: ["the requested calendar change"],
    candidateActions: [],
    requiresTool: true,
    replyEffectStatus: "pending",
    reply: "",
  },
  // General only: CALENDAR does not declare it.
  general: {
    contexts: ["general"],
    intents: ["the requested calendar change"],
    candidateActions: [],
    requiresTool: true,
    replyEffectStatus: "pending",
    reply: "",
  },
  // Opening the Calendar view instead of changing the event.
  viewSwitch: {
    contexts: ["general"],
    intents: ["Open the Calendar view"],
    candidateActions: ["VIEWS_SHOW"],
    requiresTool: true,
    replyEffectStatus: "pending",
    reply: "Opening Calendar.",
  },
};

const REQUESTS = [
  [CREATE, "CALENDAR_CREATE_EVENT"],
  [MOVE, "CALENDAR_UPDATE_EVENT"],
  [REMOVE, "CALENDAR_DELETE_EVENT"],
] as const;

describe("the calendar event phrasings name their operation", () => {
  it.each([
    [CREATE, "create"],
    ["Add an event called v613 check tomorrow at 3pm.", "create"],
    ["please create a dentist appointment for Friday at 10am", "create"],
    ["schedule a meeting with Sam tomorrow at noon", "create"],
    ["put lunch with Sam on my calendar tomorrow", "create"],
    [MOVE, "update"],
    ["reschedule the standup to tomorrow at 10:30", "update"],
    ["can you move my dentist appointment to Friday?", "update"],
    [REMOVE, "delete"],
    ["cancel my 3pm meeting", "delete"],
    ["take v613 check off my calendar", "delete"],
    // Voice transcripts capitalize and spell out the meridiem.
    ["Add an event called V613 check tomorrow at 3 p.m.", "create"],
    ["Move V613 check to 4 PM.", "update"],
    ["Delete the calendar event V613 check.", "delete"],
    ["add an event called team notes review tomorrow", "create"],
  ])("%s", (text, expected) => {
    expect(calendarEventRequest(text)).toBe(expected);
  });

  it.each([
    "add Sam Lee to my contacts",
    "create a contact called Sam Lee with 415 555 0100",
    "delete the contact Sam Lee",
    "show my contacts",
    "call Sam Lee",
    "create a note called v613 check saying first line",
    "add the line second line to v613 check",
    "delete the note v613 check",
    "move the note v613 check to Work",
    "move my alarm to 7am",
    "change my status to 5",
    "remind me tomorrow at 3pm to call Sam",
    "add Sam to the meeting",
    "add an event to my phone's calendar tomorrow at 3pm",
    "what's on my calendar tomorrow?",
    "open my calendar",
    // An event word that only describes another record.
    "add a note about the meeting",
    "create a meeting note",
    "delete the meeting notes",
    "clear my meeting notes",
    "remove the meeting link from the note",
    "delete the meeting from my notes",
    "remove the meeting reminder",
    "make an appointment reminder",
    "create an event workflow",
    "add a reminder to my calendar",
    // A pronoun's target comes from the turn's history, not this route.
    "move it to 4pm",
    "move that one to 4pm",
    // Settings set to a time.
    "change my status to 5pm",
    "change my wake-up to 7am",
  ])("leaves other requests alone: %s", (text) => {
    expect(calendarEventRequest(text)).toBeUndefined();
  });
});

describe("a calendar event request loads the calendar context from any view", () => {
  for (const view of Object.keys(VIEWS) as View[])
    describe(`${view} in front`, () => {
      it.each(
        REQUESTS.flatMap(([text, action]) =>
          Object.entries(STAGE1_SHAPES).map(
            ([shape, plan]) => [text, action, shape, plan] as const,
          ),
        ),
      )("%s -> %s (%s)", async (text, action, _shape, plan) => {
        const result = await replay(text, view, plan);
        expect(result.availableContexts).toContain("calendar");
        expect(result.plan.contexts).toContain("calendar");
        expect(result.plan.candidateActions).toContain(action);
        expect(result.plan.candidateActions).not.toContain("VIEWS_SHOW");
        expect(result.plan.requiresTool).toBe(true);
        expect(result.plan.reply ?? "").toBe("");
        expect(result.surface).toContain(action);
      });
    });

  it("keeps a Calendar plan Stage 1 already made", async () => {
    const result = await replay(CREATE, "contacts", {
      contexts: ["calendar"],
      intents: [CREATE],
      candidateActions: ["CALENDAR_CREATE_EVENT"],
      requiresTool: true,
      replyEffectStatus: "pending",
      reply: "",
    });
    expect(result.plan.candidateActions).toEqual(["CALENDAR_CREATE_EVENT"]);
    expect(result.surface).toEqual(
      expect.arrayContaining([
        "CALENDAR_CREATE_EVENT",
        "CALENDAR_UPDATE_EVENT",
        "CALENDAR_DELETE_EVENT",
      ]),
    );
  });

  it("only the request's own route matches", async () => {
    for (const [text, action] of REQUESTS) {
      const { runtime, message } = await phoneFixture(text, "contacts");
      const rules = getDirectActionRoutingRules(runtime).filter((rule) =>
        rule.matches(text, message),
      );
      expect(rules.map((rule) => rule.actionNames)).toEqual([[action]]);
    }
  });
});

describe("contacts requests still go to contacts", () => {
  it.each([
    "add Sam Lee to my contacts",
    "create a contact called Sam Lee with 415 555 0100",
    "delete the contact Sam Lee",
  ])("%s", async (text) => {
    const result = await replay(text, "contacts", {
      contexts: ["contacts"],
      intents: [text],
      candidateActions: ["PROPOSE_DEVICE_ACTION"],
      requiresTool: true,
      replyEffectStatus: "pending",
      reply: "",
    });
    expect(result.plan.contexts).toEqual(["contacts"]);
    expect(result.plan.contexts).not.toContain("calendar");
    expect(result.plan.candidateActions).toEqual(["PROPOSE_DEVICE_ACTION"]);
    // No Calendar route claims the turn. (PROPOSE_DEVICE_ACTION itself is
    // admitted only inside an authenticated device turn, which this fixture
    // does not open.)
    expect(
      getDirectActionRoutingRules(result.runtime)
        .filter((rule) => rule.matches(text, result.message))
        .map((rule) => rule.id)
        .filter((id) => id.startsWith("calendar.")),
    ).toEqual([]);
  });

  it("a plain show-my-contacts reply gains no Calendar work", async () => {
    const result = await replay("show my contacts", "contacts", {
      contexts: ["general"],
      intents: ["Open the Contacts view"],
      candidateActions: ["VIEWS_SHOW"],
      requiresTool: true,
      replyEffectStatus: "pending",
      reply: "Let me open Contacts for you.",
    });
    expect(result.plan.contexts).not.toContain("calendar");
    expect(
      result.plan.candidateActions.filter((name) =>
        name.startsWith("CALENDAR"),
      ),
    ).toEqual([]);
  });
});

describe("the planner's view context is a hint, not a limit", () => {
  it("names the open view's contexts as routing hints", async () => {
    const { runtime, message } = await phoneFixture(CREATE, "contacts");
    const result = await uiContextProvider.get(runtime, message, {
      values: {},
      data: {},
      text: "",
    } as never);
    expect(result.text).toContain("view_contexts: contacts, general");
    expect(result.text).not.toContain("active_contexts");
    expect(result.text).toContain("not a limit on this turn");
    expect(result.text).toContain("from any view");
  });
});
