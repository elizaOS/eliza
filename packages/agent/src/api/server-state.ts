/**
 * Constructs the mutable state shared by agent API route adapters. Keeping the
 * initialization contract separate from the HTTP listener makes first-run,
 * runtime-backed, and stopped-server states deterministic and testable.
 */
import {
  type AgentAutomationMode,
  type AgentRuntime,
  isInsufficientCreditsMessage,
  type AgentLogEntry as LogEntry,
} from "@elizaos/core";
import type { ElizaConfig } from "@elizaos/host/protocol";
import type { PluginEntry, ServerState } from "./server-types.ts";

/**
 * Retention of the in-memory diagnostics log (`GET /api/logs`). The buffer
 * keeps the newest `ELIZA_API_LOG_BUFFER_MAX` entries (default 1000), plus at
 * most one recent credit warning needed by chat failure replies. It may
 * briefly hold up to 10% more, because eviction runs in batches so that one
 * log line does not shift the whole array. Older entries remain in the log
 * files and the process output. This buffer is diagnostics only; it is never
 * model context.
 */
export const API_LOG_BUFFER_MAX_ENV = "ELIZA_API_LOG_BUFFER_MAX";
export const DEFAULT_API_LOG_BUFFER_MAX = 1000;

/** The existing chat fallback reads credit evidence from the last minute. */
export function findRecentInsufficientCreditsLog(
  logBuffer: LogEntry[],
  lookbackMs = 60000,
): LogEntry | null {
  const now = Date.now();
  for (let i = logBuffer.length - 1; i >= 0; i--) {
    const entry = logBuffer[i];
    if (now - entry.timestamp > lookbackMs) break;
    if (isInsufficientCreditsMessage(entry.message)) return entry;
  }
  return null;
}

/** Reads the retention from the environment; a value that is set must be a positive integer. */
export function resolveApiLogBufferMax(
  raw: string | undefined = process.env[API_LOG_BUFFER_MAX_ENV],
): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_API_LOG_BUFFER_MAX;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `${API_LOG_BUFFER_MAX_ENV} must be a positive integer, got "${raw}"`,
    );
  }
  return value;
}

/** Appends entries in place (routes hold the array reference) and applies the retention. */
export function appendApiLogEntries(
  buffer: LogEntry[],
  entries: readonly LogEntry[],
  max: number,
): void {
  for (const entry of entries) buffer.push(entry);
  if (buffer.length > max + Math.ceil(max / 10)) {
    const retainedStart = buffer.length - max;
    const credits = findRecentInsufficientCreditsLog(buffer);
    const retainCredits = credits && buffer.indexOf(credits) < retainedStart;
    buffer.splice(0, retainedStart);
    if (retainCredits) buffer.unshift(credits);
  }
}

export type InitialAgentState = Extract<
  ServerState["agentState"],
  "not_started" | "starting" | "stopped" | "error"
>;

export interface CreateServerStateOptions {
  config: ElizaConfig;
  runtime?: AgentRuntime;
  initialAgentState?: InitialAgentState;
  plugins: PluginEntry[];
  deletedConversationIds: Set<string>;
  resolveAgentName(config: ElizaConfig): string;
  detectRuntimeModel(
    runtime: AgentRuntime | null,
    config: ElizaConfig,
  ): string | undefined;
  resolveAgentAutomationMode(config: ElizaConfig): AgentAutomationMode;
  resolveTradePermissionMode(
    config: ElizaConfig,
  ): ServerState["tradePermissionMode"];
}

export function createServerState(
  options: CreateServerStateOptions,
): ServerState {
  const runtime = options.runtime ?? null;
  const hasRuntime = runtime !== null;
  const agentState = hasRuntime
    ? "running"
    : (options.initialAgentState ?? "not_started");
  const startup =
    agentState === "running"
      ? { phase: "running", attempt: 0 }
      : agentState === "starting"
        ? { phase: "starting", attempt: 0 }
        : { phase: "idle", attempt: 0 };

  return {
    runtime,
    config: options.config,
    agentState,
    agentName: hasRuntime
      ? (runtime.character.name ?? options.resolveAgentName(options.config))
      : options.resolveAgentName(options.config),
    model: hasRuntime
      ? options.detectRuntimeModel(runtime, options.config)
      : undefined,
    startedAt: hasRuntime || agentState === "starting" ? Date.now() : undefined,
    startup,
    plugins: options.plugins,
    skills: [],
    logBuffer: [],
    eventBuffer: [],
    // A dashboard retains its replay cursor across server restarts. Seed the
    // sequence from startup time to avoid resetting to evt-1 and dropping new
    // events as duplicates. This assumes the wall clock has not moved backward
    // and the previous process emitted fewer than 1000 events per millisecond.
    nextEventId: Date.now() * 1000,
    chatRoomId: null,
    chatUserId: null,
    chatConnectionReady: null,
    chatConnectionPromise: null,
    runtimeStopPromise: null,
    adminEntityId: null,
    conversations: new Map(),
    activeChatTurnCount: 0,
    conversationRestorePromise: null,
    deletedConversationIds: options.deletedConversationIds,
    cloudManager: null,
    sandboxManager: null,
    appManager: null,
    shareIngestQueue: [],
    broadcastStatus: null,
    broadcastWs: null,
    broadcastWsToClientId: null,
    broadcastWsToConversation: null,
    activeConversationId: null,
    permissionStates: {},
    shellEnabled: options.config.features?.shellEnabled !== false,
    agentAutomationMode: options.resolveAgentAutomationMode(options.config),
    tradePermissionMode: options.resolveTradePermissionMode(options.config),
    pendingRestartReasons: [],
    connectorRouteHandlers: [],
    connectorHealthMonitor: null,
    whatsappPairingSessions: new Map(),
  };
}
