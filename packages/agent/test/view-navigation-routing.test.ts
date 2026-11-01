import {
  getDirectActionRoutingRules,
  type IAgentRuntime,
  type Memory,
  promoteSubactionsToActions,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUILTIN_RESPONSE_HANDLER_EVALUATORS,
  resolveEligibleDirectActionRoutes,
} from "../../../plugins/plugin-assistant/src/services/message/stage1-evaluators.ts";
import { viewsAction } from "../src/actions/views.ts";
import {
  closeRuntimeViewRegistry,
  registerBuiltinViews,
  registerPluginViews,
} from "../src/api/views-registry.ts";
import { registerViewNavigationRoutingRule } from "../src/runtime/view-navigation.ts";
import {
  isExplicitBackViewRequest,
  resolveExplicitRegisteredViewRequest,
} from "../src/runtime/view-navigation-targets.ts";

const runtimes: IAgentRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) closeRuntimeViewRegistry(runtime);
});
function fixture() {
  const runtime = {
    agentId: "11111111-1111-4111-8111-111111111111",
    actions: promoteSubactionsToActions(viewsAction),
    getSetting: () => undefined,
    getService: () => null,
    logger: { warn: vi.fn() },
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  runtimes.push(runtime);
  registerBuiltinViews(runtime);
  registerViewNavigationRoutingRule(runtime);
  return runtime;
}
function message(text: string): Memory {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    entityId: "33333333-3333-4333-8333-333333333333",
    roomId: "44444444-4444-4444-8444-444444444444",
    content: {
      text,
      source: "client_chat",
      channelType: "DM",
      metadata: { viewClientId: "client-1" },
    },
  } as Memory;
}
async function eligible(runtime: IAgentRuntime, text: string, role = "OWNER") {
  return resolveEligibleDirectActionRoutes({
    runtime,
    message: message(text),
    state: { values: {}, data: {}, text: "" },
    userRoles: [role],
  } as never);
}
describe("registered view navigation exposure", () => {
  it("admits the existing Workflows/Home aliases through the actual registry and role gates", async () => {
    const r = fixture();
    expect(
      (await eligible(r, "Open Workflows.")).map((x) => x.action.name),
    ).toEqual(["VIEWS_SHOW"]);
    expect((await eligible(r, "Go home.")).map((x) => x.action.name)).toEqual([
      "VIEWS_SHOW",
    ]);
    expect(await eligible(r, "Open Workflows.", "NONE")).toEqual([]);
  });
  it("keeps unknown, advisory, conditional and non-navigation requests out", async () => {
    const r = fixture();
    for (const text of [
      "Open Unknown.",
      "Maybe look at Workflows.",
      "If ready, open Workflows.",
      "Do not open Workflows.",
      "Should I open Workflows?",
      "List notes.",
      "Open Workflows then create a note.",
    ])
      expect(await eligible(r, text)).toEqual([]);
  });
  it("uses dynamic registered names and rejects ambiguity or removed registries", async () => {
    const r = fixture();
    await registerPluginViews(
      r,
      {
        name: "test-custom-view",
        views: [
          {
            id: "mission",
            label: "Mission Board",
            path: "/mission",
            bundleUrl: "/mission.js",
          },
        ],
      } as never,
      { pluginDir: process.cwd(), indexEmbeddings: false },
    );
    expect((await eligible(r, "Open Mission Board.")).length).toBe(1);
    expect(
      resolveExplicitRegisteredViewRequest(
        [
          { id: "one", label: "Same" },
          { id: "two", label: "Same" },
        ],
        "Open Same.",
      ),
    ).toBeUndefined();
    closeRuntimeViewRegistry(r);
    await expect(eligible(r, "Open Workflows.")).rejects.toMatchObject({
      code: "VIEW_REGISTRY_CLOSED",
    });
  });
  it("admits a possessive or polite command for one registered view", async () => {
    const r = fixture();
    await registerPluginViews(
      r,
      {
        name: "test-calendar-view",
        views: [
          {
            id: "calendar",
            label: "Calendar",
            path: "/calendar",
            bundleUrl: "/calendar.js",
          },
        ],
      } as never,
      { pluginDir: process.cwd(), indexEmbeddings: false },
    );
    // Live :5325 2026-10-30 tj-f923be42254f79 / tj-fae6d1f612ea94: Stage 1
    // chose direct navigation, but without this route both turns ran the
    // planner and evaluator for one view switch.
    for (const text of ["Open my calendar, please.", "open my calendar"])
      expect((await eligible(r, text)).map((x) => x.action.name)).toEqual([
        "VIEWS_SHOW",
      ]);
    for (const text of [
      "open my calendar for tomorrow",
      "Open my calendar, please, then add lunch.",
    ])
      expect(await eligible(r, text)).toEqual([]);
  });
  it("admits spoken acknowledgements and a request frame around one complete command, and nothing more", async () => {
    const r = fixture();
    await registerPluginViews(
      r,
      {
        name: "test-spoken-views",
        views: [
          {
            id: "calendar",
            label: "Calendar",
            path: "/calendar",
            bundleUrl: "/calendar.js",
          },
          {
            id: "notes",
            label: "Notes",
            path: "/notes",
            bundleUrl: "/notes.js",
          },
        ],
      } as never,
      { pluginDir: process.cwd(), indexEmbeddings: false },
    );
    // Live direct stage 2026-10-31 voice turns (tj-41061eccc66d0e,
    // tj-41f9d4af5a0266, tj-6e61957c374610, tj-6efbf84c684459): Stage 1
    // chose direct navigation, and each still ran the planner and evaluator.
    for (const text of [
      "Can you open the calendar?",
      "Can you open the notes?",
      "Okay, go home.",
      "Can you go home?",
      "It's okay. Can you go home?",
      "It’s okay. Can you go home?",
      "Its okay, can you go home?",
      "Okay, cool, thank you. Can you go home?",
      "Okay, cool. Can you go home?",
      "Could you please open my calendar for me?",
      "Could you open my calendar for me, please?",
      "Please, can you open the calendar?",
      "Um, can you please open Workflows?",
      "show me notes",
      "Yeah, show me the notes.",
      ...[
        "Alright",
        "All right",
        "Yes",
        "Yep",
        "Sure",
        "Great",
        "Nice",
        "Perfect",
        "Thanks",
        "Hey",
        "Uh",
        "Oh",
        "It's fine",
        "It's alright",
      ].map((lead) => `${lead}, open the notes.`),
    ])
      expect(
        (await eligible(r, text)).map((x) => x.action.name),
        text,
      ).toEqual(["VIEWS_SHOW"]);
    for (const text of [
      "Open notes?",
      "Okay, open notes?",
      "Okay.",
      "Thank you.",
      "No, open notes.",
      "Should I open the calendar?",
      "Should I open Workflows?",
      "Can you not open the calendar?",
      "Can you please not open notes?",
      "Okay, don't open notes.",
      "Can you open notes without saying it?",
      "Can you open the calendar without saying it?",
      "Yeah, open the notes without saying the like opening notes thing.",
      "To you open the calendar and tell me um like if there's anything on it for this week.",
      "Can you open the calendar and tell me what's on it?",
      "Sure, open the calendar and tell me what's on it.",
      "Could you tell me if you can open notes?",
      "Will you open the calendar tomorrow?",
      "Can you open my calendar for tomorrow?",
      "Can you open the calendar if I have a meeting today?",
      "Okay, if ready, open the calendar.",
      "If you can, open Workflows.",
      "Why can't you open notes?",
      "Why do you keep opening the calendar?",
      "Show me what's on my calendar.",
      "Can you show me the calendar for tomorrow?",
      "Thanks. Open Workflows then create a note.",
    ])
      expect(await eligible(r, text), text).toEqual([]);
    expect(
      resolveExplicitRegisteredViewRequest(
        [{ id: "chat", label: "Chat" }],
        "Okay, cool. Can you go home?",
      ),
    ).toEqual({ view: { id: "chat", label: "Chat" }, resolvedAlias: "home" });
    // Every client chat turn reaches this route; a long message is not a
    // spoken one-view command and is declined before any pattern scan.
    for (const text of [
      `Can you open notes${", please".repeat(20)}?`,
      `open notes${" for me".repeat(30_000)} x`,
      `go back${".".repeat(30_000)}`,
    ]) {
      expect(
        resolveExplicitRegisteredViewRequest(
          [{ id: "notes", label: "Notes" }],
          text,
        ),
      ).toBeUndefined();
      expect(isExplicitBackViewRequest(text)).toBe(false);
    }
  });
  it("recognizes a spoken back request only as a complete command", () => {
    for (const text of [
      "go back",
      "Please go back.",
      "Can you go back?",
      "Okay, go back, please.",
    ])
      expect(isExplicitBackViewRequest(text), text).toBe(true);
    for (const text of [
      "Go back?",
      "Should I go back?",
      "Can you not go back?",
      "Can you go back to the calendar and add lunch?",
      "Okay.",
    ])
      expect(isExplicitBackViewRequest(text), text).toBe(false);
  });
  it("does not expose an unavailable registered view", async () => {
    const r = fixture();
    await registerPluginViews(
      r,
      {
        name: "test-missing-view",
        views: [
          {
            id: "missing",
            label: "Missing Surface",
            path: "/missing",
            bundlePath: "does-not-exist.js",
          },
        ],
      } as never,
      { pluginDir: process.cwd(), indexEmbeddings: false },
    );
    expect(await eligible(r, "Open Missing Surface.")).toEqual([]);
  });
  it("only adds capability candidates and leaves optional visual judgment unchanged", async () => {
    const r = fixture();
    const rule = getDirectActionRoutingRules(r)[0];
    expect(rule.wholeRequest).toBeUndefined();
    expect(rule.replacesActionNames).toBeUndefined();
    const handler = {
      processMessage: "RESPOND",
      plan: {
        contexts: ["general"],
        intents: ["Open Workflows"],
        candidateActions: [],
        replyEffectStatus: "applied",
      },
    };
    const evaluate = BUILTIN_RESPONSE_HANDLER_EVALUATORS.find(
      (x) => x.name === "core.direct_registered_capability_request",
    )!;
    const patch = await evaluate.evaluate({
      runtime: r,
      message: message("Open Workflows."),
      state: { values: {}, data: {}, text: "" },
      messageHandler: handler,
      userRoles: ["OWNER"],
    } as never);
    expect(patch).toMatchObject({
      requiresTool: true,
      addCandidateActions: ["VIEWS_SHOW"],
    });
    expect(patch).not.toHaveProperty("replaceIntentScope");
    expect(patch).not.toHaveProperty("replyEffectStatus");
    expect(handler.plan.replyEffectStatus).toBe("applied");
  });
  it("requires an actual renderer chat when message metadata is supplied", () => {
    const r = fixture();
    const rule = getDirectActionRoutingRules(r)[0];
    const m = message("Open Workflows.");
    delete m.content.metadata;
    expect(rule.matches("Open Workflows.", m)).toBe(false);
  });
});
