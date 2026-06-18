// Shared test fixtures + @elizaos/ui mock factory for the ClawVille view tests.
// The view components consume `useApp`, `client`, `GameOperatorShell`, and
// `useAgentElement` from @elizaos/ui; the tests mock that module so they can
// drive populated app-run state and assert against the real component logic
// (collectRunEvents, sendCommand disposition mapping, sendDraft, etc.).
//
// The fixture session/run shapes mirror the canonical real shapes produced by
// the plugin's own `buildSessionState` (see routes.ts) and exercised by the
// app smoke fixtures in packages/app/test/ui-smoke/game-apps.spec.ts.

import type { AppRunSummary, AppSessionState } from "@elizaos/shared";

export const CLAWVILLE_APP_NAME = "@elizaos/plugin-clawville";

export interface ClawvilleSessionOverrides {
  canSendCommands?: boolean;
  suggestedPrompts?: string[];
  goalLabel?: string | null;
  telemetry?: Record<string, unknown> | null;
  activity?: AppSessionState["activity"];
  status?: string;
}

export function makeClawvilleSession(
  overrides: ClawvilleSessionOverrides = {},
): AppSessionState {
  return {
    sessionId: "clawville-session",
    appName: CLAWVILLE_APP_NAME,
    mode: "spectate-and-steer",
    status: "running",
    displayName: "ClawVille",
    agentId: "eliza:agent-smoke",
    canSendCommands: overrides.canSendCommands ?? true,
    controls: [],
    summary: "Near Krusty Krab. 2 skills learned.",
    goalLabel:
      overrides.goalLabel === undefined
        ? "Near Krusty Krab. Visit or ask the local NPC."
        : overrides.goalLabel,
    suggestedPrompts: overrides.suggestedPrompts ?? [
      "Move to tool workshop",
      "Visit the nearest building",
      "Ask the nearest NPC what to learn next",
      "Move to skill forge",
    ],
    activity: overrides.activity,
    telemetry:
      overrides.telemetry === undefined
        ? {
            walletAddress: "9x9x9x9x9x9x9x9x9x9xtest",
            knowledgeCount: 2,
            totalSessions: 2,
            nearestBuildingId: "tool-workshop",
            nearestBuildingLabel: "Krusty Krab",
          }
        : (overrides.telemetry as AppSessionState["telemetry"]),
  };
}

export function makeClawvilleRun(
  overrides: Partial<AppRunSummary> & {
    session?: AppSessionState | null;
  } = {},
): AppRunSummary {
  const { session: sessionOverride, ...rest } = overrides;
  const session =
    sessionOverride === undefined ? makeClawvilleSession() : sessionOverride;
  const run: AppRunSummary = {
    runId: "clawville-run",
    appName: CLAWVILLE_APP_NAME,
    displayName: "ClawVille",
    pluginName: CLAWVILLE_APP_NAME,
    launchType: "connect",
    launchUrl: "https://clawville.world/game",
    viewer: {
      url: "/api/apps/clawville/viewer",
      sandbox: "allow-scripts allow-same-origin allow-popups allow-forms",
    },
    session,
    characterId: null,
    agentId: "agent-smoke",
    status: overrides.status ?? session?.status ?? "running",
    summary: session?.summary ?? null,
    startedAt: "2026-04-24T00:00:00.000Z",
    updatedAt: "2026-04-24T00:00:00.000Z",
    lastHeartbeatAt: "2026-04-24T00:00:00.000Z",
    supportsBackground: true,
    supportsViewerDetach: true,
    chatAvailability: "available",
    controlAvailability: "unavailable",
    viewerAttachment: "attached",
    recentEvents: [],
    awaySummary: null,
    health: { state: "healthy", message: null },
    healthDetails: {
      checkedAt: "2026-04-24T00:00:00.000Z",
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
