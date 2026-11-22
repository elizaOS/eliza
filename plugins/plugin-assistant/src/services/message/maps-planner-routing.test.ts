/**
 * Maps requests from phone chat reach the Maps operations (live v609,
 * 2026-11-18). Stage 1 had no context that exposes MAPS_*: the family
 * declared only "location"/"travel", which nothing registers. So "directions to
 * Coit Tower" was judged direct navigation (VIEWS_SHOW only, Maps showed no
 * route), and a discovery query naming "maps" was scoped to the only action
 * that declared that word, DEVICE_MAPS_READ_SELECTED.
 */
import {
  type Action,
  AgentRuntime,
  attestAuthenticatedApiDeliveryAudience,
  type Memory,
  promoteSubactionsToActions,
  runResponseHandlerEvaluators,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { viewsAction } from "../../../../../packages/agent/src/actions/views.ts";
import { enrichChatUiViewMetadata } from "../../../../../packages/agent/src/api/chat-view-metadata.ts";
import {
  closeRuntimeViewRegistry,
  listViews,
  registerBuiltinViews,
  registerPluginViews,
} from "../../../../../packages/agent/src/api/views-registry.ts";
import { registerViewNavigationRoutingRule } from "../../../../../packages/agent/src/runtime/view-navigation.ts";
import {
  isMapsDirectionsRequest,
  isMapsNearbyPlaceRequest,
  isMapsPlaceOnMapRequest,
  MAPS_CONTEXT,
  mapsGoToDestination,
  mapsPlugin,
  mapsTravelDestination,
} from "../../../../plugin-maps/src/plugin.ts";
import { MapsService } from "../../../../plugin-maps/src/service.ts";
import { DEFAULT_CONTEXT_DEFINITIONS } from "../../runtime/default-contexts.ts";
import { deviceActionTools } from "../device-actions/tools.ts";
import { retrieveContextualPlannerActions } from "./action-surface.ts";
import { plannerDiscoveryContexts } from "./provider-state.ts";
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

describe("a general turn in the Maps view starts with the Maps operations", () => {
  // The view answered in "world" while every Maps operation declares "maps".
  // A turn Stage 1 left in `general` was scoped to the registry's "world"
  // member, messaging, and reached Maps only through DISCOVER_ACTIONS.
  const messageSearch: Action = {
    name: "MESSAGE_SEARCH",
    description: "Search messages in rooms and channels.",
    contexts: ["messaging", "world"],
    validate: async () => true,
    handler: async () => ({ success: true }),
  };
  it.each(["find coffee shops", "search for a place to eat"])(
    "%s",
    async (text) => {
      const { runtime, message } = await fixture(text);
      await registerPluginViews(runtime, mapsPlugin, {
        pluginDir: process.cwd(),
        indexEmbeddings: false,
      });
      // The chat route replaces renderer metadata with the registered view's
      // facts. The phone draws Maps itself, so the view needs no hosted bundle.
      const turnIn = (uiView: string) =>
        ({
          ...message,
          content: {
            ...message.content,
            metadata: enrichChatUiViewMetadata(
              {
                viewClientId: "test-renderer",
                uiView,
                viewDelivery: "completed-action",
              },
              listViews(runtime, { viewType: "gui" }),
            ),
          },
        }) as Memory;
      // The planner's first tools when Stage 1 chose `general` and named none.
      const loaded = (turn: Memory) =>
        retrieveContextualPlannerActions({
          actions: [...runtime.actions, messageSearch],
          deferUnscopedBootstrap: true,
          query: text,
          message: turn,
          intents: [text],
          contexts: plannerDiscoveryContexts(turn, ["general"]),
          contextAliases: (context) => runtime.contexts.get(context)?.aliases,
        }).actions.map((action) => action.name);
      const inMaps = loaded(turnIn("maps"));
      expect(inMaps).toContain("MAPS_PLACE");
      expect(inMaps).not.toContain("MESSAGE_SEARCH");
      // The same request from Home names no domain and waits for discovery.
      expect(loaded(turnIn("chat"))).toEqual([]);
    },
  );
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

describe("a reply to a Maps place question continues the operation that asked", () => {
  // v610: MAPS_ROUTE asked "Which one did you mean?" and the owner said "the
  // first one". Stage 1 answered in prose ("I can't load a live route from
  // here") and no route was planned.
  const evaluator = BUILTIN_RESPONSE_HANDLER_EVALUATORS.find(
    (entry) => entry.name === "core.direct_registered_capability_request",
  );
  async function evaluate(
    text: string,
    open?: "route" | "navigation-start",
    content: Partial<Memory["content"]> = {},
    turns: { askedBy?: string; between?: string } = {},
  ) {
    if (!evaluator) throw new Error("Expected capability evaluator");
    const { runtime, message } = await fixture(text);
    Object.assign(message.content, content);
    const service = new MapsService(undefined, {} as never);
    if (open)
      service.placeChoices.set(
        { ...message, id: turns.askedBy ?? message.id },
        {
          operation: open,
          field: open === "route" ? "originQuery" : "placeQuery",
          query: "Starbucks",
          places: ["Market St", "Powell St"].map((street, index) => ({
            provider: "maps",
            providerPlaceId: street,
            name: "Starbucks",
            formattedAddress: street,
            coordinates: { latitude: 37.79, longitude: -122.4 - index / 100 },
            categories: [],
          })),
          queries: {},
          resolved: {},
        },
      );
    const getService = runtime.getService.bind(runtime);
    vi.spyOn(runtime, "getService").mockImplementation(((name: string) =>
      name === "maps" ? service : getService(name)) as never);
    const run = async (turn: Memory) => {
      const handler = {
        processMessage: "RESPOND",
        plan: {
          contexts: ["simple"],
          intents: [],
          candidateActions: [] as string[],
          parentActionHints: [],
          requiresTool: false,
          replyEffectStatus: "none",
          reply: "Locked in the first one.",
        },
      };
      await runResponseHandlerEvaluators({
        runtime,
        message: turn,
        state: { text: "", values: {}, data: {} },
        messageHandler: handler,
        availableContexts: [...DEFAULT_CONTEXT_DEFINITIONS, MAPS_CONTEXT],
        userRoles: ["OWNER"],
        evaluators: [evaluator],
      } as never);
      return handler;
    };
    // An owner turn between the question and this reply ("call mom").
    if (turns.between !== undefined)
      await run({
        ...message,
        id: "44444444-4444-4444-8444-444444444444",
        content: { ...message.content, text: turns.between },
      } as Memory);
    return run(message);
  }
  it.each([
    ["the first one", "route", ["MAPS_ROUTE"]],
    ["The second one.", "route", ["MAPS_ROUTE"]],
    ["2", "navigation-start", ["MAPS_NAVIGATION_START"]],
  ] as const)("%s", async (text, open, expected) => {
    const handler = await evaluate(text, open);
    expect(handler.plan.requiresTool).toBe(true);
    expect(handler.plan.candidateActions).toEqual(expected);
    expect(handler.plan.contexts).toContain("maps");
  });
  it("takes the owner's next turn after the question", async () => {
    const handler = await evaluate(
      "the first one",
      "route",
      {},
      {
        askedBy: "22222222-2222-4222-8222-222222222222",
      },
    );
    expect(handler.plan.candidateActions).toEqual(["MAPS_ROUTE"]);
  });
  it("leaves a later reply to whatever asked since the owner moved on", async () => {
    // The owner left the Maps question for another request; "the first one"
    // now answers that request's question (a contact, an email), not Maps.
    const handler = await evaluate(
      "the first one",
      "route",
      {},
      {
        askedBy: "22222222-2222-4222-8222-222222222222",
        between: "call mom",
      },
    );
    expect(handler.plan.requiresTool).toBe(false);
    expect(handler.plan.candidateActions).toEqual([]);
  });
  it("leaves an ordinal outside the choices offered to the planner", async () => {
    const handler = await evaluate("the third one", "route");
    expect(handler.plan.candidateActions).toEqual([]);
  });
  it("leaves the reply alone when no Maps question is open", async () => {
    const handler = await evaluate("the first one");
    expect(handler.plan.requiresTool).toBe(false);
    expect(handler.plan.candidateActions).toEqual([]);
  });
  it("leaves other replies alone while a question is open", async () => {
    const handler = await evaluate("thanks, that's all", "route");
    expect(handler.plan.requiresTool).toBe(false);
  });
  it("does not take a reply on another channel", async () => {
    const handler = await evaluate("the first one", "route", {
      source: "discord",
      channelType: "GROUP",
    });
    expect(handler.plan.requiresTool).toBe(false);
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
    ["go to coit tower", ["MAPS_NAVIGATION_START", "MAPS_ROUTE"]],
    ["go to the museum of modern art", ["MAPS_NAVIGATION_START", "MAPS_ROUTE"]],
    ["go to JFK Terminal 4", ["MAPS_NAVIGATION_START", "MAPS_ROUTE"]],
    ["go to cloud apps", []],
    ["go to privacy policy", []],
    ["go to account history", []],
    ["go to the terminal output", []],
    ["go to SFO and pick up Alex", []],
    ["go to SFO with Sam tomorrow", []],
  ])(
    "only promotes a clear destination from the voice transcript %s",
    async (text, expected) => {
      const handler = await evaluate(text, { channelType: "VOICE_DM" });
      expect(mapsCandidates(handler)).toEqual(expected);
    },
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
    ["go to Coit Tower", ["MAPS_NAVIGATION_START", "MAPS_ROUTE"]],
    ["go to the Ferry Building", ["MAPS_NAVIGATION_START", "MAPS_ROUTE"]],
    [
      "go to 1 Market St, San Francisco",
      ["MAPS_NAVIGATION_START", "MAPS_ROUTE"],
    ],
    [
      "Okay, go to Golden Gate Park, please.",
      ["MAPS_NAVIGATION_START", "MAPS_ROUTE"],
    ],
    [
      "take me to 1 Market St, San Francisco, CA 94105",
      ["MAPS_NAVIGATION_START", "MAPS_ROUTE"],
    ],
    ["is there a pharmacy near me?", ["MAPS_PLACE", "MAPS_NAVIGATION_START"]],
    [
      "where's the closest gas station?",
      ["MAPS_PLACE", "MAPS_NAVIGATION_START"],
    ],
    ["where can I get coffee nearby?", ["MAPS_PLACE", "MAPS_NAVIGATION_START"]],
    ["any good tacos around here?", ["MAPS_PLACE", "MAPS_NAVIGATION_START"]],
    ["find a pharmacy nearby", ["MAPS_PLACE", "MAPS_NAVIGATION_START"]],
    // A named place to search around needs no position from the phone.
    ["pharmacy near the Ferry Building", ["MAPS_PLACE"]],
    ["find a pharmacy near the ferry building", ["MAPS_PLACE"]],
    ["is there a pharmacy near Union Square?", ["MAPS_PLACE"]],
    [
      "Are there any coffee shops close by?",
      ["MAPS_PLACE", "MAPS_NAVIGATION_START"],
    ],
    // Speech-to-text writes places in lowercase.
    ["go to coit tower", ["MAPS_NAVIGATION_START", "MAPS_ROUTE"]],
    ["go to the ferry building", ["MAPS_NAVIGATION_START", "MAPS_ROUTE"]],
    ["go to golden gate park", ["MAPS_NAVIGATION_START", "MAPS_ROUTE"]],
    ["go to the grocery store", ["MAPS_NAVIGATION_START", "MAPS_ROUTE"]],
    ["go to the nearest gas station", ["MAPS_NAVIGATION_START", "MAPS_ROUTE"]],
    ["take me to coit tower", ["MAPS_NAVIGATION_START", "MAPS_ROUTE"]],
    ["navigate to golden gate park", ["MAPS_NAVIGATION_START", "MAPS_ROUTE"]],
    // An all-caps place code.
    ["go to SFO", ["MAPS_NAVIGATION_START", "MAPS_ROUTE"]],
    ["go to JFK Terminal 4", ["MAPS_NAVIGATION_START", "MAPS_ROUTE"]],
    ["take me to JFK", ["MAPS_NAVIGATION_START", "MAPS_ROUTE"]],
    ["directions to LAX", ["MAPS_ROUTE", "MAPS_NAVIGATION_START"]],
    // One capitalised word: a well-known place, or an explicit travel verb.
    ["go to Starbucks", ["MAPS_NAVIGATION_START", "MAPS_ROUTE"]],
    ["go to starbucks", ["MAPS_NAVIGATION_START", "MAPS_ROUTE"]],
    ["go to mcdonald’s", ["MAPS_NAVIGATION_START", "MAPS_ROUTE"]],
    ["go to 7-Eleven", ["MAPS_NAVIGATION_START", "MAPS_ROUTE"]],
    [
      "go to new york botanical garden",
      ["MAPS_NAVIGATION_START", "MAPS_ROUTE"],
    ],
    ["go to Walgreens", ["MAPS_NAVIGATION_START", "MAPS_ROUTE"]],
    ["let's go to Safeway", ["MAPS_NAVIGATION_START", "MAPS_ROUTE"]],
    ["go to the Presidio", ["MAPS_NAVIGATION_START", "MAPS_ROUTE"]],
    ["take me to Starbucks", ["MAPS_NAVIGATION_START", "MAPS_ROUTE"]],
    ["navigate to Alcatraz", ["MAPS_NAVIGATION_START", "MAPS_ROUTE"]],
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
    "go to settings",
    "go to Settings",
    "go to Notes",
    "go to the Calendar",
    "Can you go to Workflows?",
    "go home",
    "go to cloud apps",
    "take me to cloud apps",
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
    "go to the top",
    "go to page 3",
    "Go to Page 3",
    "go to the next slide",
    "go to the Next Slide",
    "go to example.com",
    "go to sleep",
    "go to bed",
    "go to my inbox",
    "go to the previous one",
    "go to line 40",
    "Go to Line 40",
    "go to definition",
    "Go To Definition",
    "go to Google Drive",
    "go to Monday",
    "go to Q3",
    "go to 10 percent",
    "go to the right place",
    "go to Coit Tower, then text Sam",
    "go to Coit Tower, Sam",
    "don't go to Coit Tower",
    // Lowercase speech that is not a place: an idiom, a pronoun, one word,
    // a time, more work, or an app, page or software word.
    "go to work",
    "go to school",
    "go to church",
    "go to war",
    "go to waste",
    "go to town",
    "go to pieces",
    "go to great lengths",
    "go to bed early",
    "go to work tomorrow",
    "go to my house",
    "go to your settings",
    "go to this page",
    "go to that place",
    "go to it now",
    "go to the store",
    "go to the main branch",
    "go to the error log",
    "go to lunch with sam",
    "go to the store and buy milk",
    "go to see a movie",
    "go to the gas station tomorrow",
    "go to the second floor",
    "go to the nearest integer",
    "go to the app store",
    "go to apple music",
    "go to the home screen",
    "go to coit tower then text sam",
    "go to coit tower if it's open",
    "go to coit tower.com",
    "go to the settings tab",
    // One capitalised word after "go to" may be a person or an app.
    "go to Sam",
    "go to Notion",
    "go to Figma",
    "go to Alcatraz",
    "Okay, go to Sam, please.",
    // All-caps words that are a file, a format, a time or one letter.
    "go to PDF",
    "go to the FAQ",
    "go to HTML",
    "go to PM",
    "go to Q3",
    "go to A",
    "go to SFOOBAR",
    "is there anything near me in my calendar",
    "where can I get help with this bug",
    "find a nearby value in the array",
    "near me in the list",
    "is there anyone nearby",
    "is there a way around here",
    "is there a bug near me in this code",
    "any errors near me in the log",
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

  it.each([
    ["go to Coit Tower", "Coit Tower"],
    ["go to the Ferry Building", "the Ferry Building"],
    ["go to 1 Market St, San Francisco", "1 Market St, San Francisco"],
    ["go to 500 howard street", "500 howard street"],
    ["go to market street", "market street"],
    ["let's go to McDonald's", "McDonald's"],
    ["go to Home Depot", "Home Depot"],
    ["go to the top", undefined],
    ["go to my inbox", undefined],
    ["go to settings", undefined],
    ["go to 40", undefined],
    ["go to coit tower", "coit tower"],
    ["go to the ferry building", "the ferry building"],
    ["go to the museum of modern art", "the museum of modern art"],
    ["go to pier 39", "pier 39"],
    ["go to the nearest gas station", "the nearest gas station"],
    ["go to Sam", undefined],
    ["go to Notion", undefined],
    ["go to Starbucks", "Starbucks"],
    ["go to the Presidio", "the Presidio"],
    ["go to SFO", "SFO"],
    ["go to UCSF Medical Center", "UCSF Medical Center"],
    ["go to the FAQ", undefined],
    ["go to the right place", undefined],
    ["go to great lengths", undefined],
    ["go to the bottom of the list", undefined],
  ])("reads the go-to place in %s", (text, expected) => {
    expect(mapsGoToDestination(text)).toBe(expected);
  });

  it.each(["take me to Coit Tower", "go to Coit Tower"])(
    "stays out of %s when no host view registry can tell a view from a place",
    async (text) => {
      if (!evaluator) throw new Error("Expected capability evaluator");
      expect(mapsTravelDestination(text) ?? mapsGoToDestination(text)).toBe(
        "Coit Tower",
      );
      const { runtime, message } = await fixture(text, {
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
    },
  );
});
