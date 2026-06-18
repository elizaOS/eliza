// Shared test fixtures for the Hyperscape view tests.
//
// The view components consume `useApp`, `client`, the surface helpers
// (SurfaceBadge/SurfaceCard/SurfaceSection/SurfaceEmptyState, the toneFor*
// helpers, formatDetailTimestamp, selectLatestRunForApp) from
// @elizaos/app-core/ui-compat, plus `Button` from @elizaos/ui and
// `useAgentElement` from @elizaos/ui/agent-surface. The tests mock those modules
// so they can drive populated app-run state and assert against the real
// component logic (extractRecentActivity, sendOperatorMessage, handleControl,
// sendDraft, the TUI view-state shape, etc.).
//
// The fixture session/run shapes mirror the canonical real shapes produced by
// the plugin's own `buildSession()` (see routes.ts): sessionId = agentId, mode
// "spectate-and-steer", status running/connecting, controls ["pause"]/["resume"],
// canSendCommands, followEntity = characterId, goalLabel, suggestedPrompts, and
// the telemetry record (goalsPaused / availableGoalCount / nearbyLocationCount /
// recommendedGoals / recentThoughts).

import type { AppRunSummary, AppSessionState } from "@elizaos/shared";

export const HYPERSCAPE_APP_NAME = "@elizaos/plugin-hyperscape";

export interface HyperscapeSessionOverrides {
  canSendCommands?: boolean;
  suggestedPrompts?: string[];
  goalLabel?: string | null;
  controls?: AppSessionState["controls"];
  status?: string;
  followEntity?: string;
  characterId?: string;
  summary?: string | null;
  activity?: AppSessionState["activity"];
  telemetry?: Record<string, unknown> | null;
}

export function makeHyperscapeSession(
  overrides: HyperscapeSessionOverrides = {},
): AppSessionState {
  return {
    sessionId: "hyper-agent-1",
    appName: HYPERSCAPE_APP_NAME,
    mode: "spectate-and-steer",
    status: overrides.status ?? "running",
    agentId: "hyper-agent-1",
    characterId:
      overrides.characterId === undefined
        ? "milady-character"
        : overrides.characterId,
    followEntity:
      overrides.followEntity === undefined
        ? "milady-character"
        : overrides.followEntity,
    canSendCommands: overrides.canSendCommands ?? true,
    controls: overrides.controls ?? ["pause"],
    summary: overrides.summary === undefined ? null : overrides.summary,
    goalLabel:
      overrides.goalLabel === undefined
        ? "Explore the northern district"
        : overrides.goalLabel,
    suggestedPrompts: overrides.suggestedPrompts ?? [
      "look around",
      "follow the merchant",
      "head to the plaza",
    ],
    activity: overrides.activity,
    telemetry:
      overrides.telemetry === undefined
        ? {
            goalsPaused: false,
            availableGoalCount: 2,
            nearbyLocationCount: 3,
            recommendedGoals: [
              {
                id: "goal-0",
                type: "explore",
                description: "Scout the plaza",
                reason: "High foot traffic",
              },
            ],
            recentThoughts: [
              {
                id: "thought-1",
                type: "plan",
                content: "Head north to find the merchant",
                timestamp: 1_700_000_000_000,
              },
            ],
          }
        : (overrides.telemetry as AppSessionState["telemetry"]),
  };
}

export function makeHyperscapeRun(
  overrides: Partial<AppRunSummary> & {
    session?: AppSessionState | null;
  } = {},
): AppRunSummary {
  const { session: sessionOverride, ...rest } = overrides;
  const session =
    sessionOverride === undefined ? makeHyperscapeSession() : sessionOverride;
  const run: AppRunSummary = {
    runId: "hyper-run",
    appName: HYPERSCAPE_APP_NAME,
    displayName: "Hyperscape",
    pluginName: HYPERSCAPE_APP_NAME,
    launchType: "connect",
    launchUrl: "https://hyperscape.io/world",
    viewer: {
      url: "/api/apps/hyperscape/viewer",
      sandbox: "allow-scripts allow-same-origin allow-popups allow-forms",
      postMessageAuth: true,
      authMessage: {
        type: "HYPERSCAPE_AUTH",
        authToken: "tok-abc",
        agentId: "hyper-agent-1",
        characterId: "milady-character",
        followEntity: "milady-character",
      },
    },
    session,
    characterId: "milady-character",
    agentId: "hyper-agent-1",
    status: overrides.status ?? session?.status ?? "running",
    summary: session?.summary ?? null,
    startedAt: "2026-05-19T00:00:00.000Z",
    updatedAt: "2026-05-19T00:00:00.000Z",
    lastHeartbeatAt: "2026-05-19T00:00:05.000Z",
    supportsBackground: true,
    supportsViewerDetach: true,
    chatAvailability: "available",
    controlAvailability: "available",
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
      control: { state: "healthy", message: null },
      message: null,
    },
  };
  // Apply remaining caller overrides, then re-pin the resolved session last so a
  // caller-supplied `status` can win without clobbering the session object.
  return { ...run, ...rest, session };
}
