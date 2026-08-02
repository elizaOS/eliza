/**
 * Constructs the mutable state shared by agent API route adapters. Keeping the
 * initialization contract separate from the HTTP listener makes first-run,
 * runtime-backed, and stopped-server states deterministic and testable.
 */
import type { AgentRuntime } from "@elizaos/core";
import type { ElizaConfig } from "../config/config.ts";
import type {
  AgentAutomationMode,
  PluginEntry,
  ServerState,
} from "./server-types.ts";

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
    nextEventId: 1,
    chatRoomId: null,
    chatUserId: null,
    chatConnectionReady: null,
    chatConnectionPromise: null,
    adminEntityId: null,
    conversations: new Map(),
    activeChatTurnCount: 0,
    conversationRestorePromise: null,
    deletedConversationIds: options.deletedConversationIds,
    cloudManager: null,
    sandboxManager: null,
    appManager: null,
    trainingService: null,
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
