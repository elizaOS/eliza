// Shared test fixtures for the 'scape view suite.
//
// SINGLE SOURCE OF TRUTH: the realistic session telemetry consumed by every
// component test is produced by the REAL route producer (`refreshRunSession` ->
// `buildScapeSessionState` in src/routes.ts) running over a real-shaped xRSPS
// `PerceptionSnapshot` (src/sdk/types.ts) plus a JournalService stub. So the
// component tests assert against exactly what the production pipeline emits, not
// a hand-written telemetry blob — and the parser-contract test re-reads the same
// output through extractTelemetry to prove producer/consumer shapes agree.

import type { AppSessionState } from "@elizaos/shared";
import type {
  JournalGoal,
  JournalMemory,
  JournalState,
} from "../journal/types.js";
import type { PerceptionSnapshot } from "../sdk/types.js";

export const SCAPE_APP_NAME = "@elizaos/plugin-scape";
export const SCAPE_AGENT_ID = "scape:agent-7";

// ── A realistic xRSPS PerceptionSnapshot (the "LumbridgeRanger" fixture) ──────
// Coordinates and shapes mirror the OSRS Lumbridge cow field. `self` at
// (3225, 3265); a Cow 1 tile away and a Goblin 2 tiles away; a farther player; a
// Bones ground item; skills + inventory. NPCs are intentionally out of distance
// order in the source array so the producer's nearest-first sort is observable.
export function makeScapePerception(): PerceptionSnapshot {
  return {
    tick: 128,
    self: {
      id: 1,
      name: "LumbridgeRanger",
      combatLevel: 4,
      hp: 8,
      maxHp: 10,
      x: 3225,
      z: 3265,
      level: 0,
      runEnergy: 91,
      inCombat: false,
    },
    skills: [
      { id: 1, name: "Attack", level: 4, baseLevel: 4, xp: 388 },
      { id: 3, name: "Hitpoints", level: 10, baseLevel: 10, xp: 1154 },
      { id: 2, name: "Strength", level: 3, baseLevel: 3, xp: 174 },
    ],
    inventory: [
      { slot: 0, itemId: 315, name: "Shrimps", count: 3 },
      { slot: 1, itemId: 1205, name: "Bronze dagger", count: 1 },
    ],
    equipment: [],
    // Goblin is listed FIRST but is 2 tiles away; Cow is listed second but is
    // only 1 tile away — the producer must reorder to Cow, Goblin.
    nearbyNpcs: [
      {
        id: 2001,
        defId: 100,
        name: "Goblin",
        x: 3227,
        z: 3265,
        hp: 5,
        combatLevel: 2,
      },
      {
        id: 2000,
        defId: 81,
        name: "Cow",
        x: 3226,
        z: 3265,
        hp: 8,
        combatLevel: 2,
      },
    ],
    nearbyPlayers: [
      { id: 9001, name: "Zezima", x: 3230, z: 3266, combatLevel: 126 },
    ],
    nearbyGroundItems: [
      { itemId: 526, name: "Bones", x: 3225, z: 3267, count: 1 },
    ],
    nearbyObjects: [],
    recentEvents: [],
  };
}

export function makeScapeActiveGoal(): JournalGoal {
  return {
    id: "goal-1",
    title: "Train attack on cows",
    notes: "Stay in the Lumbridge cow field until level 10 attack.",
    status: "active",
    source: "operator",
    progress: 0.25,
    createdAt: 1_716_000_000_000,
    updatedAt: 1_716_000_500_000,
  };
}

export function makeScapeMemory(): JournalMemory {
  return {
    id: "mem-1",
    kind: "goal",
    text: "Spotted a cow nearby — beginning attack training.",
    weight: 4,
    timestamp: 1_716_000_400_000,
    x: 3225,
    z: 3265,
  };
}

export function makeScapeJournalState(): JournalState {
  return {
    agentId: SCAPE_AGENT_ID,
    displayName: "LumbridgeRanger",
    createdAt: 1_716_000_000_000,
    updatedAt: 1_716_000_500_000,
    sessionCount: 3,
    memories: [makeScapeMemory()],
    goals: [makeScapeActiveGoal()],
    progress: [],
  };
}

// Minimal JournalService surface buildScapeSessionState reads.
function makeJournalServiceStub() {
  const state = makeScapeJournalState();
  const activeGoal = makeScapeActiveGoal();
  return {
    getState: () => state,
    getActiveGoal: () => activeGoal,
    getGoals: () => state.goals,
  };
}

interface ScapeServiceStubOptions {
  status?: string;
  paused?: boolean;
  operatorGoal?: string;
  perception?: PerceptionSnapshot | null;
  withJournal?: boolean;
  eventLog?: Array<{
    stepNumber: number;
    action: string;
    message: string;
    success: boolean;
  }>;
}

// Minimal ScapeGameService surface buildScapeSessionState reads. Returned by the
// runtime stub's getService("scape_game").
function makeScapeServiceStub(options: ScapeServiceStubOptions) {
  const journal =
    options.withJournal === false ? null : makeJournalServiceStub();
  return {
    isPausedByOperator: () => options.paused === true,
    getOperatorGoal: () => options.operatorGoal ?? "",
    getStatus: () => options.status ?? "connected",
    getPerception: () => options.perception ?? null,
    getJournalService: () => journal,
    getRecentEventLog: (_n: number) => options.eventLog ?? [],
  };
}

interface ScapeRuntimeStubOptions extends ScapeServiceStubOptions {
  agentId?: string;
  withService?: boolean;
}

// A runtime stub shaped like the bits resolveScapeSessionId / getScapeService /
// resolveClientUrl read off IAgentRuntime.
export function makeScapeRuntimeStub(options: ScapeRuntimeStubOptions = {}) {
  const service =
    options.withService === false ? null : makeScapeServiceStub(options);
  return {
    agentId: options.agentId ?? "agent-7",
    getSetting: (_key: string) => undefined,
    getService: (name: string) => (name === "scape_game" ? service : null),
  };
}

// Build the REAL session state via the plugin's exported refreshRunSession.
// `refreshRunSession` -> `buildScapeSessionState` is the production producer.
export async function buildRealScapeSession(
  options: ScapeRuntimeStubOptions = {},
): Promise<AppSessionState> {
  const { refreshRunSession } = await import("../routes.js");
  const runtime = makeScapeRuntimeStub({
    status: "connected",
    perception: makeScapePerception(),
    ...options,
  });
  // refreshRunSession only reads ctx.runtime.
  const session = await refreshRunSession({
    runtime,
  } as unknown as Parameters<typeof refreshRunSession>[0]);
  if (!session) throw new Error("refreshRunSession returned no session");
  return session as AppSessionState;
}

// An app-run row shaped like AppRunState, wrapping a real-producer session.
export interface ScapeRunOverrides {
  runId?: string | null;
  status?: string;
  health?: { state: string };
  viewerAttachment?: string;
  session?: AppSessionState | Record<string, unknown>;
}

export function makeScapeRun(
  session: AppSessionState | Record<string, unknown>,
  overrides: ScapeRunOverrides = {},
): Record<string, unknown> {
  return {
    runId: overrides.runId === undefined ? "scape-run" : overrides.runId,
    appName: SCAPE_APP_NAME,
    status: overrides.status ?? "running",
    updatedAt: "2026-05-19T00:00:00.000Z",
    health: overrides.health ?? { state: "healthy" },
    viewerAttachment: overrides.viewerAttachment ?? "attached",
    session: overrides.session ?? session,
  };
}
