// Shared test fixtures + @elizaos/* mock factory for the Defense of the Agents
// view tests. The view components consume `useApp`, `client`,
// `GameOperatorShell`, `SurfaceBadge`, `SurfaceEmptyState`,
// `selectLatestRunForApp`, `toneForStatusText` from `@elizaos/app-core/ui-compat`
// and `useAgentElement` from `@elizaos/ui/agent-surface`. The tests mock those
// modules so they can drive populated app-run state and assert against the real
// component logic (formatHeroLine, collectRunEvents, cleanDefenseMessage,
// sendCommand disposition mapping, sendDraft, primary-action derivation, etc.).
//
// The fixture session/run shapes mirror the canonical real shapes produced by
// the plugin's own `buildSessionState` / `buildTelemetry` (see routes.ts).

import type { AppRunSummary, AppSessionState } from "@elizaos/shared";

export const DEFENSE_APP_NAME = "@elizaos/plugin-defense-of-the-agents";

export interface DefenseSessionOverrides {
  canSendCommands?: boolean;
  suggestedPrompts?: string[];
  goalLabel?: string | null;
  summary?: string | null;
  telemetry?: Record<string, unknown> | null;
  activity?: AppSessionState["activity"];
  status?: string;
}

// Telemetry shape matches buildTelemetry() in routes.ts: a Mage Lv3 mid-lane
// hero at 80/100 HP with auto-play running and one recent activity entry.
export function makeDefenseTelemetry(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    gameId: "3",
    tick: 42,
    winner: null,
    heroFaction: "human",
    heroClass: "mage",
    heroLane: "mid",
    heroLevel: 3,
    heroHp: 80,
    heroMaxHp: 100,
    heroAlive: true,
    heroAbilityChoices: 2,
    autoPlay: true,
    recentActivity: [
      { ts: 1_700_000_000_000, action: "command", detail: "Holding mid lane" },
    ],
    ...overrides,
  };
}

export function makeDefenseSession(
  overrides: DefenseSessionOverrides = {},
): AppSessionState {
  return {
    sessionId: "Eliza",
    appName: DEFENSE_APP_NAME,
    mode: "spectate-and-steer",
    status: overrides.status ?? "running",
    displayName: "Defense of the Agents",
    agentId: "agent-defense",
    canSendCommands: overrides.canSendCommands ?? true,
    controls: [],
    summary:
      overrides.summary === undefined
        ? "Mage level 3 in mid lane, 80/100 HP."
        : overrides.summary,
    goalLabel:
      overrides.goalLabel === undefined
        ? "Mage holding mid lane"
        : overrides.goalLabel,
    suggestedPrompts: overrides.suggestedPrompts ?? [
      "Auto-play OFF",
      "Move to top lane",
      "Recall to base",
      "Review strategy",
    ],
    activity: overrides.activity,
    telemetry:
      overrides.telemetry === undefined
        ? (makeDefenseTelemetry() as AppSessionState["telemetry"])
        : (overrides.telemetry as AppSessionState["telemetry"]),
  };
}

export function makeDefenseRun(
  overrides: Partial<AppRunSummary> & {
    session?: AppSessionState | null;
  } = {},
): AppRunSummary {
  const { session: sessionOverride, ...rest } = overrides;
  const session =
    sessionOverride === undefined ? makeDefenseSession() : sessionOverride;
  const run: AppRunSummary = {
    runId: "defense-run",
    appName: DEFENSE_APP_NAME,
    displayName: "Defense of the Agents",
    pluginName: DEFENSE_APP_NAME,
    launchType: "connect",
    launchUrl: "https://www.defenseoftheagents.com/",
    viewer: {
      url: "/api/apps/defense-of-the-agents/viewer",
      sandbox: "allow-scripts allow-same-origin allow-popups allow-forms",
    },
    session,
    characterId: null,
    agentId: "agent-defense",
    status: overrides.status ?? session?.status ?? "running",
    summary: session?.summary ?? null,
    startedAt: "2026-05-19T00:00:00.000Z",
    updatedAt: "2026-05-19T00:00:00.000Z",
    lastHeartbeatAt: "2026-05-19T00:00:00.000Z",
    supportsBackground: true,
    supportsViewerDetach: true,
    chatAvailability: "available",
    controlAvailability: "unavailable",
    viewerAttachment: "attached",
    recentEvents: [],
    awaySummary: null,
    health: { state: "healthy", message: null },
    healthDetails: {
      checkedAt: "2026-05-19T00:00:00.000Z",
      auth: { state: "healthy", message: null },
      runtime: { state: "healthy", message: null },
      viewer: { state: "healthy", message: null },
      chat: { state: "healthy", message: null },
      control: { state: "unknown", message: null },
      message: null,
    },
  };
  // Apply remaining caller overrides, then re-pin the resolved session last so a
  // caller-supplied `status` can win without clobbering the session object.
  return { ...run, ...rest, session };
}
