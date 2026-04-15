import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type {
  AppLaunchSessionContext,
  AppRunSessionContext,
  AppSessionJsonValue,
  AppSessionState,
  AppLaunchResult,
} from "@elizaos/shared/contracts/apps";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 8_000;
const THOUGHTS_LIMIT = 5;
const HYPERSCAPE_SESSION_MODE = "spectate-and-steer" as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeStringSetting(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveApiBase(runtime: IAgentRuntime | null): string | null {
  // Prefer the explicit API URL when the host has configured one;
  // otherwise fall back to the viewer client URL. Unit tests and
  // local dev only set `HYPERSCAPE_CLIENT_URL` (the Hyperscape API
  // is served from the same origin as the client), so treating the
  // client URL as an API fallback keeps the route module active in
  // those contexts without requiring duplicated env configuration.
  const rawCandidates: unknown[] = [
    typeof runtime?.getSetting === "function"
      ? runtime.getSetting("HYPERSCAPE_API_URL")
      : null,
    process.env.HYPERSCAPE_API_URL,
    typeof runtime?.getSetting === "function"
      ? runtime.getSetting("HYPERSCAPE_CLIENT_URL")
      : null,
    process.env.HYPERSCAPE_CLIENT_URL,
  ];
  for (const raw of rawCandidates) {
    const candidate = normalizeStringSetting(raw);
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      return candidate.replace(/\/+$/, "");
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function resolveAgentId(
  runtime: IAgentRuntime | null,
  viewer: AppLaunchResult["viewer"] | null,
): string | null {
  const authMsg = viewer?.authMessage;
  const fromViewer =
    typeof authMsg?.agentId === "string" ? authMsg.agentId : null;
  const fromRuntime =
    typeof runtime?.agentId === "string" && runtime.agentId.trim()
      ? runtime.agentId.trim()
      : null;
  return fromViewer || fromRuntime;
}

function resolveCharacterId(
  runtime: IAgentRuntime | null,
  viewer: AppLaunchResult["viewer"] | null,
): string | null {
  const authMsg = viewer?.authMessage;
  const fromViewer =
    typeof authMsg?.characterId === "string" ? authMsg.characterId : null;
  if (fromViewer) return fromViewer;
  return normalizeStringSetting(
    typeof runtime?.getSetting === "function"
      ? runtime.getSetting("HYPERSCAPE_CHARACTER_ID")
      : null,
  );
}

async function fetchJson<T = unknown>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Live data types
// ---------------------------------------------------------------------------

interface EmbeddedAgentRecord {
  agentId?: string;
  state?: string;
  startedAt?: number;
  lastActivity?: number;
}

interface GoalRecord {
  description?: string;
  type?: string;
  reason?: string;
}

interface QuickCommand {
  label?: string;
  command?: string;
  available?: boolean;
}

interface NearbyLocation {
  name?: string;
}

interface ThoughtRecord {
  id?: string;
  type?: string;
  content?: string;
  timestamp?: number;
}

async function fetchLiveData(
  base: string,
  agentId: string,
): Promise<{
  agentRecord: EmbeddedAgentRecord | null;
  goal: GoalRecord | null;
  goalsPaused: boolean;
  availableGoals: GoalRecord[];
  quickCommands: QuickCommand[];
  nearbyLocations: NearbyLocation[];
  thoughts: ThoughtRecord[];
}> {
  const id = encodeURIComponent(agentId);
  const [agentsRes, goalRes, quickActionsRes, thoughtsRes] = await Promise.all([
    fetchJson<{ agents?: EmbeddedAgentRecord[] }>(
      `${base}/api/embedded-agents`,
    ),
    fetchJson<{
      goal?: GoalRecord | null;
      goalsPaused?: boolean;
      availableGoals?: GoalRecord[];
    }>(`${base}/api/agents/${id}/goal`),
    fetchJson<{
      quickCommands?: QuickCommand[];
      nearbyLocations?: NearbyLocation[];
    }>(`${base}/api/agents/${id}/quick-actions`),
    fetchJson<{ thoughts?: ThoughtRecord[] }>(
      `${base}/api/agents/${id}/thoughts?limit=${THOUGHTS_LIMIT}`,
    ),
  ]);

  const agents = agentsRes?.agents ?? [];
  const agentRecord =
    agents.find((a) => a.agentId === agentId) ??
    (agents.length === 1 ? agents[0] : null) ??
    null;

  return {
    agentRecord,
    goal: goalRes?.goal ?? null,
    goalsPaused: goalRes?.goalsPaused === true,
    availableGoals: goalRes?.availableGoals ?? [],
    quickCommands: quickActionsRes?.quickCommands ?? [],
    nearbyLocations: quickActionsRes?.nearbyLocations ?? [],
    thoughts: thoughtsRes?.thoughts ?? [],
  };
}

function buildSession(
  appName: string,
  agentId: string,
  characterId: string | null,
  data: Awaited<ReturnType<typeof fetchLiveData>>,
): AppSessionState {
  const {
    agentRecord,
    goal,
    goalsPaused,
    availableGoals,
    quickCommands,
    nearbyLocations,
    thoughts,
  } = data;

  const isRunning = agentRecord?.state === "running";

  const controls: AppSessionState["controls"] = isRunning
    ? ["pause"]
    : ["resume"];

  const goalLabel = goal?.description ?? null;
  const suggestedPrompts = quickCommands
    .filter((c) => c.available !== false && typeof c.command === "string")
    .map((c) => c.command as string);

  const recommendedGoals = availableGoals.map((g, i) => ({
    id: `goal-${i}`,
    type: g.type ?? "general",
    description: g.description ?? "",
    reason: g.reason,
  }));

  const recentThoughts = thoughts.slice(0, THOUGHTS_LIMIT).map((t) => ({
    id: t.id,
    type: t.type,
    content: t.content,
    timestamp: t.timestamp,
  }));

  const telemetry: Record<string, AppSessionJsonValue> = {
    goalsPaused,
    availableGoalCount: availableGoals.length,
    nearbyLocationCount: nearbyLocations.length,
  };
  if (typeof agentRecord?.startedAt === "number") {
    telemetry.startedAt = agentRecord.startedAt;
  }
  if (typeof agentRecord?.lastActivity === "number") {
    telemetry.lastActivity = agentRecord.lastActivity;
  }
  if (recommendedGoals.length > 0) {
    telemetry.recommendedGoals =
      recommendedGoals as unknown as AppSessionJsonValue;
  }
  if (recentThoughts.length > 0) {
    telemetry.recentThoughts = recentThoughts as unknown as AppSessionJsonValue;
  }

  return {
    sessionId: agentId,
    appName,
    mode: HYPERSCAPE_SESSION_MODE,
    status: isRunning ? "running" : "connecting",
    agentId,
    characterId: characterId ?? undefined,
    followEntity: characterId ?? undefined,
    canSendCommands: true,
    controls,
    summary: isRunning ? null : "Connecting session...",
    goalLabel,
    suggestedPrompts,
    telemetry,
  };
}

// ---------------------------------------------------------------------------
// Exported route module interface (AppRouteModule)
// ---------------------------------------------------------------------------

export async function resolveLaunchSession(
  ctx: AppLaunchSessionContext,
): Promise<AppSessionState | null> {
  const { appName, runtime, viewer } = ctx;
  const base = resolveApiBase(runtime);
  if (!base) {
    logger.debug(
      "[hyperscape] HYPERSCAPE_API_URL not configured; skipping live session resolution",
    );
    return null;
  }

  const agentId = resolveAgentId(runtime, viewer);
  if (!agentId) {
    logger.debug(
      "[hyperscape] No agentId available; skipping live session resolution",
    );
    return null;
  }

  const characterId = resolveCharacterId(runtime, viewer);

  try {
    const data = await fetchLiveData(base, agentId);
    return buildSession(appName, agentId, characterId, data);
  } catch (err) {
    logger.warn(
      `[hyperscape] Failed to resolve live session: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export async function refreshRunSession(
  ctx: AppRunSessionContext,
): Promise<AppSessionState | null> {
  const { appName, runtime, viewer, session } = ctx;
  if (!session) return null;

  const base = resolveApiBase(runtime);
  if (!base) return null;

  const agentId = session.agentId ?? resolveAgentId(runtime, viewer);
  if (!agentId) return null;

  const characterId =
    session.characterId ?? resolveCharacterId(runtime, viewer);

  try {
    const data = await fetchLiveData(base, agentId);
    return buildSession(appName, agentId, characterId, data);
  } catch (err) {
    logger.warn(
      `[hyperscape] Failed to refresh run session: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
