/**
 * Maps requests from phone chat reach the Maps operations (live v609,
 * 2026-11-18). Stage 1 had no context that exposes MAPS_*: the family
 * declared only "location"/"travel", which nothing registers. So "directions to
 * Coit Tower" was judged direct navigation (VIEWS_SHOW only, Maps showed no
 * route), and a discovery query naming "maps" was scoped to the only action
 * that declared that word, DEVICE_MAPS_READ_SELECTED.
 */
import {
  AgentRuntime,
  attestAuthenticatedApiDeliveryAudience,
  type Memory,
  promoteSubactionsToActions,
  runResponseHandlerEvaluators,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { viewsAction } from "../../../../../packages/agent/src/actions/views.ts";
import {
  closeRuntimeViewRegistry,
  registerBuiltinViews,
  registerPluginViews,
} from "../../../../../packages/agent/src/api/views-registry.ts";
import { registerViewNavigationRoutingRule } from "../../../../../packages/agent/src/runtime/view-navigation.ts";
import {
  isMapsDirectionsRequest,
  isMapsNearbyPlaceRequest,
  isMapsPlaceOnMapRequest,
  MAPS_CONTEXT,
  mapsPlugin,
  mapsTravelDestination,
} from "../../../../plugin-maps/src/plugin.ts";
import { DEFAULT_CONTEXT_DEFINITIONS } from "../../runtime/default-contexts.ts";
import { deviceActionTools } from "../device-actions/tools.ts";
import { BUILTIN_RESPONSE_HANDLER_EVALUATORS } from "./stage1-evaluators.ts";
import { createPlannerToolDiscoveryAction } from "./tool-discovery.ts";

const owner = "11111111-1111-4111-8111-111111111111",
  room = "22222222-2222-4222-8222-222222222222";
const runtimes: AgentRuntime[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) closeRuntimeViewRegistry(runtime);
});

const deviceMapsRead = deviceActionTools.find(
  (action) => action.name === "DEVICE_MAPS_READ_SELECTED",
);
const mapsActions = mapsPlugin.actions ?? [];

async function fixture(text: string, { viewNames = true } = {}) {
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
  if (!deviceMapsRead) throw new Error("Expected DEVICE_MAPS_READ_SELECTED");
  for (const action of [
    ...mapsActions,
    deviceMapsRead,
    ...promoteSubactionsToActions(viewsAction),
  ])
    runtime.registerAction(action);
  registerBuiltinViews(runtime);
  // The phone's own views, so "navigate to notes" names a registered view.
  await registerPluginViews(
    runtime,
    {
      name: "test-phone-views",
      description: "Fixture phone views",
      views: [
        { id: "notes", label: "Notes", path: "/notes", bundleUrl: "/notes.js" },
        {
          id: "calendar",
          label: "Calendar",
          path: "/calendar",
          bundleUrl: "/calendar.js",
        },
      ],
    },
    { pluginDir: process.cwd(), indexEmbeddings: false },
  );
  // The host registers the view-name resolver the Maps travel route consults.
  if (viewNames) registerViewNavigationRoutingRule(runtime);
  await mapsPlugin.init?.({}, runtime);
  const message = {
    id: "33333333-3333-4333-8333-333333333333",
    agentId: runtime.agentId,
    entityId: owner,
    roomId: room,
    content: {
      text,
      source: "client_chat",
      channelType: "DM",
      metadata: { viewClientId: "test-renderer", uiView: "maps" },
    },
  } as Memory;
  await attestAuthenticatedApiDeliveryAudience(runtime, message, {
    kind: "owner_session",
    principalId: "fixture",
  });
  return { runtime, message };
}

describe("Stage 1 can name Maps work", () => {
  it("registers a maps context that every Maps operation declares", async () => {
    const { runtime } = await fixture("hello");
    expect(runtime.contexts.get("maps")).toMatchObject({ id: "maps" });
    expect(MAPS_CONTEXT.aliases).toEqual(
      expect.arrayContaining(["location", "travel"]),
    );
    const names = mapsActions.map((action) => action.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "MAPS_PLACE",
        "MAPS_SELECT",
        "MAPS_ROUTE",
        "MAPS_NAVIGATION_START",
      ]),
    );
    for (const action of mapsActions)
      expect(action.contexts, action.name).toContain("maps");
  });
});

describe("discovery for a maps query loads the Maps operations", () => {
  it.each([
    "maps search place directions route",
    "maps directions route from place to place",
  ])("%s", async (query) => {
    const { runtime, message } = await fixture("directions to Coit Tower");
    if (!deviceMapsRead) throw new Error("Expected DEVICE_MAPS_READ_SELECTED");
    const loaded: string[] = [];
    const discovery = createPlannerToolDiscoveryAction(
      [...mapsActions, deviceMapsRead],
      (actions) => loaded.push(...actions.map((action) => action.name)),
    );
    const result = await discovery.handler?.(runtime, message, undefined, {
      parameters: { query },
    } as never);
    expect(result).toMatchObject({ success: true });
    expect(
      (result as { data?: { inferredContexts?: string[] } }).data
        ?.inferredContexts,
    ).toContain("maps");
    // The phone's selected-place read was the only match before the fix.
    expect(loaded).toContain("MAPS_ROUTE");
  });
});

describe("a directions request is routed to Maps, not only to the Maps view", () => {
  const evaluator = BUILTIN_RESPONSE_HANDLER_EVALUATORS.find(
    (entry) => entry.name === "core.direct_registered_capability_request",
  );
  it.each([
    ["directions to Coit Tower", ["MAPS_ROUTE", "MAPS_NAVIGATION_START"]],
    [
      "directions from the Ferry Building to Golden Gate Park",
      ["MAPS_ROUTE", "MAPS_NAVIGATION_START"],
    ],
    [
      "Can you get me walking directions to Coit Tower?",
      ["MAPS_ROUTE", "MAPS_NAVIGATION_START"],
    ],
    [
      "show the Ferry Building in San Francisco on the map",
      ["MAPS_SELECT", "MAPS_PLACE"],
    ],
    [
      "Could you show me the Ferry Building on the map?",
      ["MAPS_SELECT", "MAPS_PLACE"],
    ],
  ])("%s", async (text, expected) => {
    if (!evaluator) throw new Error("Expected capability evaluator");
    const { runtime, message } = await fixture(text);
    // The live Stage-1 plan for "directions to Coit Tower".
    const handler = {
      processMessage: "RESPOND",
      plan: {
        contexts: ["general"],
        intents: [`Open directions to ${text} in Maps`],
        candidateActions: ["VIEWS_SHOW"],
        parentActionHints: [],
        requiresTool: true,
        replyEffectStatus: "pending",
        reply: "Let me open Maps.",
      },
    };
    await runResponseHandlerEvaluators({
      runtime,
      message,
      state: { text: "", values: {}, data: {} },
      messageHandler: handler,
      availableContexts: [...DEFAULT_CONTEXT_DEFINITIONS, MAPS_CONTEXT],
      userRoles: ["OWNER"],
      evaluators: [evaluator],
    } as never);
    expect(handler.plan.candidateActions).toEqual(expected);
    // A non-general context also keeps view-navigation's VIEWS-only shortcut
    // (packages/agent/src/runtime/view-navigation.ts) from claiming the turn.
    expect(handler.plan.contexts).toContain("maps");
    expect(handler.plan.requiresTool).toBe(true);
  });

  it.each([
    "open maps",
    "show me the map",
    "what are directions?",
    "send directions to Coit Tower to Sam",
    "don't give me directions to Coit Tower",
    "the directions to the party were wrong",
    "show my notes",
    "take me to settings",
    "how do I get to the settings page?",
    "navigate to notes",
    "find the way to fix this bug",
    "show me the way to export my notes",
    // A task or a software route, not a place (cross-area review).
    "directions to assemble the shelf",
    "Directions to assemble the shelf?",
    "give me directions to fix the sink",
    "get me directions to set up my printer",
    "show me directions to bake bread",
    "route to the database",
    "directions from the manual",
  ])("leaves other requests alone: %s", (text) => {
    expect(isMapsDirectionsRequest(text) || isMapsPlaceOnMapRequest(text)).toBe(
      false,
    );
  });
});

describe("the Maps routes claim only the owner's phone chat", () => {
  const evaluator = BUILTIN_RESPONSE_HANDLER_EVALUATORS.find(
    (entry) => entry.name === "core.direct_registered_capability_request",
  );
  const simplePlan = () => ({
    processMessage: "RESPOND",
    plan: {
      contexts: ["simple"],
      intents: [],
      candidateActions: [],
      parentActionHints: [],
      requiresTool: false,
      replyEffectStatus: "none",
      reply: "Here are the steps.",
    },
  });
  async function evaluate(
    text: string,
    content: Partial<Memory["content"]> = {},
  ) {
    if (!evaluator) throw new Error("Expected capability evaluator");
    const { runtime, message } = await fixture(text);
    Object.assign(message.content, content);
    const handler = simplePlan();
    await runResponseHandlerEvaluators({
      runtime,
      message,
      state: { text: "", values: {}, data: {} },
      messageHandler: handler,
      availableContexts: [...DEFAULT_CONTEXT_DEFINITIONS, MAPS_CONTEXT],
      userRoles: ["OWNER"],
      evaluators: [evaluator],
    } as never);
    return handler;
  }
  it.each([
    "directions to assemble the shelf",
    "give me directions to fix the sink",
    "get me directions to set up my printer",
  ])("keeps the simple answer for %s", async (text) => {
    const handler = await evaluate(text);
    expect(handler.plan.requiresTool).toBe(false);
    expect(handler.plan.contexts).toEqual(["simple"]);
    expect(handler.plan.reply).toBe("Here are the steps.");
  });
  it("does not take a directions request on another channel", async () => {
    const handler = await evaluate("directions to Coit Tower", {
      source: "discord",
      channelType: "GROUP",
    });
    expect(handler.plan.requiresTool).toBe(false);
    expect(handler.plan.candidateActions).toEqual([]);
  });
  it("still promotes a simple answer to a directions request in phone chat", async () => {
    const handler = await evaluate("directions to Coit Tower");
    expect(handler.plan.requiresTool).toBe(true);
    expect(handler.plan.candidateActions).toEqual([
      "MAPS_ROUTE",
      "MAPS_NAVIGATION_START",
    ]);
  });
});

describe("travel and nearby requests reach Maps from a simple Stage-1 answer", () => {
  const evaluator = BUILTIN_RESPONSE_HANDLER_EVALUATORS.find(
    (entry) => entry.name === "core.direct_registered_capability_request",
  );
  // Stage 1 answered "take me to Coit Tower" with a simple reply, so nothing
  // reached Maps and no route was planned.
  const simplePlan = () => ({
    processMessage: "RESPOND",
    plan: {
      contexts: ["simple"],
      intents: [],
      candidateActions: [] as string[],
      parentActionHints: [],
      requiresTool: false,
      replyEffectStatus: "none",
      reply: "Sure.",
    },
  });
  async function evaluate(
    text: string,
    content: Partial<Memory["content"]> = {},
  ) {
    if (!evaluator) throw new Error("Expected capability evaluator");
    const { runtime, message } = await fixture(text);
    Object.assign(message.content, content);
    const handler = simplePlan();
    await runResponseHandlerEvaluators({
      runtime,
      message,
      state: { text: "", values: {}, data: {} },
      messageHandler: handler,
      availableContexts: [...DEFAULT_CONTEXT_DEFINITIONS, MAPS_CONTEXT],
      userRoles: ["OWNER"],
      evaluators: [evaluator],
    } as never);
    return handler;
  }
  const mapsCandidates = (handler: ReturnType<typeof simplePlan>) =>
    (handler.plan.candidateActions ?? []).filter((name) =>
      name.startsWith("MAPS_"),
    );

  it.each([
    ["take me to Coit Tower", ["MAPS_NAVIGATION_START", "MAPS_ROUTE"]],
    ["navigate to the Ferry Building", ["MAPS_NAVIGATION_START", "MAPS_ROUTE"]],
    [
      "how do I get to Golden Gate Park",
      ["MAPS_NAVIGATION_START", "MAPS_ROUTE"],
    ],
    [
      "Can you take me to Coit Tower, please?",
      ["MAPS_NAVIGATION_START", "MAPS_ROUTE"],
    ],
    ["find the nearest pharmacy", ["MAPS_PLACE", "MAPS_NAVIGATION_START"]],
    ["nearest coffee shop", ["MAPS_PLACE", "MAPS_NAVIGATION_START"]],
    [
      "Where is the closest gas station?",
      ["MAPS_PLACE", "MAPS_NAVIGATION_START"],
    ],
    ["coffee shops near me", ["MAPS_PLACE", "MAPS_NAVIGATION_START"]],
  ])("promotes %s", async (text, expected) => {
    const handler = await evaluate(text);
    expect(handler.plan.requiresTool).toBe(true);
    expect(handler.plan.candidateActions).toEqual(expected);
    expect(handler.plan.contexts).toContain("maps");
  });

  it.each([
    "take me to settings",
    "navigate to notes",
    "go to the calendar",
    "take me to the calendar",
    "how do I get to my notes?",
    "navigate to workflows",
    "take me home",
  ])("leaves a view destination to navigation: %s", async (text) => {
    const handler = await evaluate(text);
    expect(mapsCandidates(handler)).toEqual([]);
    expect(handler.plan.contexts).not.toContain("maps");
  });

  it.each([
    "nearest neighbor algorithm",
    "explain the nearest neighbor algorithm",
    "round to the nearest dollar",
    "what is the nearest integer to 3.7",
    "closest pair of points",
    "stay near me",
    "keep your phone nearby",
    "how do I get to know her",
    "how do I get to sleep",
    "navigate to the next page",
    "take me to the top",
    "take me to example.com",
    "take me to Coit Tower, then text Sam",
    "don't take me to Coit Tower",
  ])("keeps the simple answer for %s", async (text) => {
    expect(isMapsNearbyPlaceRequest(text)).toBe(false);
    const handler = await evaluate(text);
    expect(mapsCandidates(handler)).toEqual([]);
    expect(handler.plan.reply).toBe("Sure.");
  });

  it.each(["take me to Coit Tower", "find the nearest pharmacy"])(
    "does not take %s on another channel",
    async (text) => {
      for (const content of [
        { source: "discord", channelType: "GROUP" },
        { source: "client_chat", channelType: "GROUP" },
        { source: "telegram", channelType: "DM" },
      ]) {
        const handler = await evaluate(text, content);
        expect(handler.plan.requiresTool, JSON.stringify(content)).toBe(false);
        expect(handler.plan.candidateActions).toEqual([]);
      }
    },
  );

  it("stays out when no host view registry can tell a view from a place", async () => {
    if (!evaluator) throw new Error("Expected capability evaluator");
    expect(mapsTravelDestination("take me to Coit Tower")).toBe("Coit Tower");
    const { runtime, message } = await fixture("take me to Coit Tower", {
      viewNames: false,
    });
    const handler = simplePlan();
    await runResponseHandlerEvaluators({
      runtime,
      message,
      state: { text: "", values: {}, data: {} },
      messageHandler: handler,
      availableContexts: [...DEFAULT_CONTEXT_DEFINITIONS, MAPS_CONTEXT],
      userRoles: ["OWNER"],
      evaluators: [evaluator],
    } as never);
    expect(handler.plan.requiresTool).toBe(false);
    expect(handler.plan.candidateActions).toEqual([]);
  });
});
