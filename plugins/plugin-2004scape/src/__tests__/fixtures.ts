// Shared realistic fixtures for 2004scape view + route tests.
//
// Two fixture families:
//   1. `populatedRun` — an AppRunSummary-shaped run whose `session.telemetry`
//      already holds the bridge-normalized telemetry the GUI/TUI/detail views
//      read directly (this is what `GET .../session/:id` returns to the client).
//   2. `realBotWorldState` + `bridgeNormalizedTelemetry` — the REAL 2004scape
//      client `getBotState()` shape (per src/sdk/types.ts BotWorldState, with the
//      richer per-NPC/loc `optionsWithIndex` the in-browser bridge in routes.ts
//      actually reads) and the telemetry the injected `buildTelemetry()` derives
//      from it. The contract test pushes the normalized telemetry through the
//      real `bridge/sync` route handler and asserts the parser surfaces the
//      fields the views consume.

import type { BotWorldState } from "../sdk/types";

// --- Bridge-normalized telemetry (output of injected buildTelemetry / trim*) ---
// Shape verified against src/routes.ts buildTelemetry(): player.worldX/worldZ/
// hp/maxHp, nearbyNpcs[].optionsWithIndex[].text, nearbyLocs[].optionsWithIndex,
// skills[].name/level, inventory[].name/amount, gameMessages[].sender/text,
// recentDialogs[].text[], combatStyle.weaponName/activeStyle, recentActivity[].
export const bridgeNormalizedTelemetry = {
  inGame: true,
  statusText: "Logged in",
  tutorial: {
    active: true,
    guideNearby: true,
    visible: true,
    prompt: "Talk to the RuneScape Guide to begin.",
  },
  player: {
    name: "oakbot42",
    combatLevel: 3,
    hp: 9,
    maxHp: 10,
    worldX: 3222,
    worldZ: 3218,
    animId: -1,
    runEnergy: 100,
    runWeight: 0,
  },
  combatStyle: {
    currentStyle: 0,
    weaponName: "Bronze axe",
    activeStyle: "Accurate",
  },
  inventory: [
    { id: 1351, name: "Bronze axe", amount: 1 },
    { id: 1511, name: "Logs", amount: 3 },
  ],
  skills: [
    { name: "Woodcutting", level: 5, experience: 388 },
    { name: "Hitpoints", level: 10, experience: 1154 },
  ],
  nearbyNpcs: [
    {
      index: 7,
      name: "RuneScape Guide",
      distance: 1.4,
      x: 3223,
      z: 3218,
      optionsWithIndex: [{ text: "Talk-to", opIndex: 1 }],
    },
    {
      index: 12,
      name: "Fishing spot",
      distance: 4.2,
      x: 3225,
      z: 3220,
      optionsWithIndex: [{ text: "Net", opIndex: 1 }],
    },
  ],
  nearbyLocs: [
    {
      id: 1276,
      name: "Tree",
      distance: 2.0,
      x: 3224,
      z: 3216,
      optionsWithIndex: [{ text: "Chop down", opIndex: 1 }],
    },
  ],
  gameMessages: [
    { text: "Welcome to 2004scape.", sender: "", tick: 4, type: 0 },
    { text: "You get some logs.", sender: "", tick: 12, type: 0 },
  ],
  recentDialogs: [
    {
      text: ["Greetings, adventurer.", "Talk to me to learn the basics."],
      tick: 8,
      interfaceId: 3559,
    },
  ],
  autoPlay: true,
  paused: false,
  intent: "tutorial",
  goal: "Finish tutorial and reach the mainland.",
  recentActivity: [
    {
      action: "woodcut",
      detail: "Started chopping Tree.",
      ts: 1_716_000_000_500,
      severity: "info",
    },
    {
      action: "login",
      detail: "Logging in as oakbot42.",
      ts: 1_716_000_000_100,
      severity: "info",
    },
  ],
};

// --- Populated run consumed by the GUI / TUI / detail views via useApp() ---
export function makePopulatedRun(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const session = {
    sessionId: "sess-oakbot42",
    appName: "@elizaos/plugin-2004scape",
    mode: "spectate-and-steer",
    status: "running",
    displayName: "2004scape",
    characterId: "oakbot42",
    canSendCommands: true,
    controls: ["pause"],
    summary: "Tutorial island: working through the starter flow.",
    goalLabel: "Finish tutorial and reach the mainland.",
    suggestedPrompts: [
      "Finish tutorial",
      "Talk to the RuneScape Guide",
      "Explore nearby",
    ],
    telemetry: bridgeNormalizedTelemetry,
    activity: [],
    ...(overrides.session as Record<string, unknown> | undefined),
  };
  const { session: _ignored, ...rest } = overrides;
  return {
    runId: "run-oakbot42",
    appName: "@elizaos/plugin-2004scape",
    status: "running",
    updatedAt: "2026-05-19T00:00:00.000Z",
    summary: "Autoplay loop is live.",
    supportsBackground: true,
    health: { state: "healthy", message: "Live loop is responding." },
    viewerAttachment: "attached",
    lastHeartbeatAt: "2026-05-19T00:00:00.000Z",
    recentEvents: [],
    viewer: {
      url: "https://rs-sdk-demo.fly.dev/bot",
      postMessageAuth: true,
      embedParams: { bot: "oakbot42" },
      authMessage: {
        authToken: "oakbot42",
        sessionToken: "secretpw",
        characterId: "oakbot42",
      },
    },
    session,
    ...rest,
  };
}

// --- Real 2004scape client getBotState() shape (BotWorldState, src/sdk/types.ts).
// Used to document the upstream contract the injected bridge trims. The bridge's
// trim* helpers read the richer client fields (optionsWithIndex on npcs/locs)
// which the published BotWorldState NearbyNpc type abbreviates as `options`; the
// live client emits both, so the contract here mirrors what getBotState() returns
// at runtime and is the input buildTelemetry() consumes.
export const realBotWorldState: BotWorldState & {
  player: NonNullable<BotWorldState["player"]>;
} = {
  tick: 42,
  inGame: true,
  player: {
    name: "oakbot42",
    combatLevel: 3,
    hp: 9,
    maxHp: 10,
    worldX: 3222,
    worldZ: 3218,
    level: 3,
    animId: -1,
    runEnergy: 100,
    runWeight: 0,
    inCombat: false,
    combatTarget: null,
    lastDamageTick: -1,
  },
  skills: [
    { id: 8, name: "Woodcutting", level: 5, baseLevel: 5, xp: 388 },
    { id: 3, name: "Hitpoints", level: 10, baseLevel: 10, xp: 1154 },
  ],
  inventory: [
    { id: 1351, name: "Bronze axe", count: 1, slot: 0 },
    { id: 1511, name: "Logs", count: 3, slot: 1 },
  ],
  equipment: [],
  nearbyNpcs: [
    {
      nid: 7,
      name: "RuneScape Guide",
      combatLevel: 0,
      worldX: 3223,
      worldZ: 3218,
      distance: 1.4,
      options: ["Talk-to"],
    },
    {
      nid: 12,
      name: "Fishing spot",
      combatLevel: 0,
      worldX: 3225,
      worldZ: 3220,
      distance: 4.2,
      options: ["Net"],
    },
  ],
  nearbyLocs: [
    {
      locId: 1276,
      name: "Tree",
      worldX: 3224,
      worldZ: 3216,
      distance: 2.0,
      options: ["Chop down"],
    },
  ],
  groundItems: [],
  gameMessages: [
    { text: "Welcome to 2004scape.", type: "0", tick: 4 },
    { text: "You get some logs.", type: "0", tick: 12 },
  ],
  combatEvents: [],
  dialog: {
    isOpen: true,
    npcName: "RuneScape Guide",
    text: "Greetings, adventurer.",
    options: [],
  },
  shop: null,
  bank: null,
  combatStyle: {
    currentStyle: 0,
    weaponName: "Bronze axe",
    styles: [
      { name: "Accurate", xpType: "Attack" },
      { name: "Aggressive", xpType: "Strength" },
    ],
  },
  modalOpen: false,
  recentDialogs: [
    {
      isOpen: true,
      npcName: "RuneScape Guide",
      text: "Greetings, adventurer.",
      options: [],
    },
  ],
};
