import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type {
  AppLaunchDiagnostic,
  AppLaunchPreparation,
  AppLaunchResult,
  AppLaunchSessionContext,
  AppRunSessionContext,
  AppSessionJsonValue,
  AppSessionState,
  AppViewerAuthMessage,
} from "@elizaos/shared";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 8_000;
const HYPERSCAPE_WALLET_AUTH_TIMEOUT_MS = 5_000;
const THOUGHTS_LIMIT = 5;
const HYPERSCAPE_SESSION_MODE = "spectate-and-steer" as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeStringSetting(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toAppSessionJsonValue(
  value: unknown,
  depth = 0,
): AppSessionJsonValue | undefined {
  if (depth > 6) return null;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => toAppSessionJsonValue(entry, depth + 1))
      .filter((entry): entry is AppSessionJsonValue => entry !== undefined);
  }
  if (typeof value === "object") {
    const record: Record<string, AppSessionJsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      const next = toAppSessionJsonValue(entry, depth + 1);
      if (next !== undefined) {
        record[key] = next;
      }
    }
    return record;
  }
  return undefined;
}

function resolveSettingLike(
  runtime: IAgentRuntime | null | undefined,
  key: string,
): string | undefined {
  const fromRuntime =
    typeof runtime?.getSetting === "function" ? runtime.getSetting(key) : null;
  if (typeof fromRuntime === "string" && fromRuntime.trim().length > 0) {
    return fromRuntime.trim();
  }
  const fromEnv = process.env[key];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return undefined;
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

function normalizeAbsoluteHttpUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return raw.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function persistCredential(
  runtime: IAgentRuntime | null,
  key: "HYPERSCAPE_AUTH_TOKEN" | "HYPERSCAPE_CHARACTER_ID",
  value: string,
  secret = false,
): void {
  if (!runtime) {
    return;
  }

  try {
    runtime.setSetting?.(key, value, secret);
  } catch (err) {
    logger.error(`[hyperscape] Failed to persist credential "${key}": ${err}`);
  }

  const character = runtime.character as {
    settings?: { secrets?: Record<string, string> };
    secrets?: Record<string, string>;
  };
  if (!character.settings) {
    character.settings = {};
  }
  if (!character.settings.secrets) {
    character.settings.secrets = {};
  }
  character.settings.secrets[key] = value;
  if (!character.secrets) {
    character.secrets = {};
  }
  character.secrets[key] = value;
}

function resolveApiBaseUrl(runtime: IAgentRuntime | null): string | null {
  const configuredUrl = resolveSettingLike(runtime, "HYPERSCAPE_API_URL");
  const normalized = normalizeAbsoluteHttpUrl(configuredUrl);
  if (configuredUrl && !normalized) {
    logger.warn(
      "[hyperscape] Ignoring invalid HYPERSCAPE_API_URL; expected an absolute http/https URL.",
    );
  }
  return normalized;
}

async function resolveRuntimeEvmAddress(
  runtime: IAgentRuntime,
): Promise<string | null> {
  let agent: unknown;
  try {
    if (typeof runtime.getAgent === "function" && runtime.agentId) {
      agent = await runtime.getAgent(runtime.agentId);
    }
  } catch {
    agent = null;
  }
  const walletAddresses =
    agent && typeof agent === "object"
      ? (agent as { walletAddresses?: { evm?: string } }).walletAddresses
      : undefined;
  const evm = walletAddresses?.evm?.trim();
  if (evm) {
    return evm;
  }

  const existingPk =
    resolveSettingLike(runtime, "EVM_PRIVATE_KEY")?.trim() ||
    process.env.EVM_PRIVATE_KEY?.trim();
  if (!existingPk) {
    return null;
  }
  const walletApiModule = "@elizaos/agent";
  const { deriveEvmAddress } = (await import(
    /* webpackIgnore: true */ walletApiModule
  )) as {
    deriveEvmAddress: (privateKey: string) => string;
  };
  return deriveEvmAddress(existingPk);
}

async function prepareWalletAuthFromRuntime(
  runtime: IAgentRuntime | null,
): Promise<void> {
  if (!runtime) {
    return;
  }
  if (resolveSettingLike(runtime, "HYPERSCAPE_AUTH_TOKEN")) {
    return;
  }
  const base = resolveApiBaseUrl(runtime);
  if (!base) {
    return;
  }
  const evm = await resolveRuntimeEvmAddress(runtime);
  if (!evm) {
    logger.info(
      "[hyperscape] Skipping wallet auth: no EVM address or EVM_PRIVATE_KEY is available.",
    );
    return;
  }
  try {
    const walletAuthUrl = new URL("/api/agents/wallet-auth", `${base}/`);
    const res = await fetch(walletAuthUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        walletAddress: evm,
        walletType: "evm",
        agentName: runtime.character?.name,
        agentId: runtime.agentId,
      }),
      signal: AbortSignal.timeout(HYPERSCAPE_WALLET_AUTH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return;
    }
    const data = (await res.json()) as {
      success?: unknown;
      authToken?: unknown;
      characterId?: unknown;
    };
    if (data.success !== true || typeof data.authToken !== "string") {
      return;
    }
    persistCredential(runtime, "HYPERSCAPE_AUTH_TOKEN", data.authToken, true);
    if (typeof data.characterId === "string" && data.characterId.trim()) {
      persistCredential(
        runtime,
        "HYPERSCAPE_CHARACTER_ID",
        data.characterId.trim(),
      );
    }
  } catch {
    // Viewer can still load without auth when the external API is unavailable.
  }
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

  const recommendedGoals: AppSessionJsonValue[] = availableGoals.map((g, i) => ({
    id: `goal-${i}`,
    type: g.type ?? "general",
    description: g.description ?? "",
    reason: typeof g.reason === "string" ? g.reason : null,
  }));

  const recentThoughts: AppSessionJsonValue[] = thoughts
    .slice(0, THOUGHTS_LIMIT)
    .map((t) => ({
      id: t.id,
      type: t.type,
      content: toAppSessionJsonValue(t.content) ?? null,
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
    telemetry.recommendedGoals = recommendedGoals;
  }
  if (recentThoughts.length > 0) {
    telemetry.recentThoughts = recentThoughts;
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

export async function prepareLaunch(ctx: {
  runtime: IAgentRuntime | null;
}): Promise<AppLaunchPreparation> {
  await prepareWalletAuthFromRuntime(ctx.runtime ?? null);
  return {};
}

export async function resolveViewerAuthMessage(ctx: {
  runtime: IAgentRuntime | null;
}): Promise<AppViewerAuthMessage | null> {
  const runtime = ctx.runtime ?? null;
  const authToken = resolveSettingLike(runtime, "HYPERSCAPE_AUTH_TOKEN");
  if (!authToken) {
    return null;
  }
  const agentId =
    typeof runtime?.agentId === "string" && runtime.agentId.trim().length > 0
      ? runtime.agentId.trim()
      : undefined;
  if (!agentId) {
    return null;
  }
  const characterId =
    resolveSettingLike(runtime, "HYPERSCAPE_CHARACTER_ID") ?? agentId;
  return {
    type: "HYPERSCAPE_AUTH",
    authToken,
    agentId,
    characterId,
    followEntity: characterId,
  };
}

export async function collectLaunchDiagnostics(ctx: {
  viewer: AppLaunchResult["viewer"] | null;
}): Promise<AppLaunchDiagnostic[]> {
  if (ctx.viewer?.postMessageAuth && !ctx.viewer.authMessage) {
    return [
      {
        code: "hyperscape-auth-unavailable",
        severity: "error",
        message:
          "Hyperscape postMessage auth requires HYPERSCAPE_AUTH_TOKEN and a runtime agent id.",
      },
    ];
  }
  return [];
}

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

/**
 * Called by the host app-manager when the user stops the Hyperscape run.
 * Hyperscape is a stateless session resolver against an external API —
 * there are no local resources (WebSockets, timers, processes) to tear
 * down. Iframe unmount is sufficient. This hook is present so the
 * app-manager lifecycle path stays uniform across all game apps.
 */
export async function stopRun(): Promise<void> {
  // Intentional no-op — no server-side state to clean up.
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
