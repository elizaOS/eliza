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
} from "../../../../../packages/agent/src/api/views-registry.ts";
import {
  isMapsDirectionsRequest,
  isMapsPlaceOnMapRequest,
  MAPS_CONTEXT,
  mapsPlugin,
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

async function fixture(text: string) {
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
  ])("leaves other requests alone: %s", (text) => {
    expect(isMapsDirectionsRequest(text) || isMapsPlaceOnMapRequest(text)).toBe(
      false,
    );
  });
});
