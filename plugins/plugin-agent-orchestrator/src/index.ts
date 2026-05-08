/**
 * Agent Orchestrator Plugin for Eliza
 *
 * Canonical orchestration plugin: combines the ACP-based subprocess spawn
 * surface (acpx) with workspace lifecycle, GitHub integration, task share,
 * task history, runtime-driven sub-agent routing, and supporting services.
 *
 * Replaces the legacy split between `@elizaos/plugin-agent-orchestrator`
 * (PTY + workspace) and `@elizaos/plugin-agent-orchestrator` (ACP spawn) — both now live
 * here.
 *
 * @module @elizaos/plugin-agent-orchestrator
 */

import type { Plugin, ServiceClass } from "@elizaos/core";
// Side-effect: register coding-agent HTTP routes with the runtime route registry.
import "./register-routes.js";
import { tasksAction } from "./actions/tasks.js";
import { codingAgentExamplesProvider } from "./providers/action-examples.js";
import { activeSubAgentsProvider } from "./providers/active-sub-agents.js";
import { activeWorkspaceContextProvider } from "./providers/active-workspace-context.js";
import { availableAgentsProvider } from "./providers/available-agents.js";
import { AcpService } from "./services/acp-service.js";
import { PTYService } from "./services/pty-service.js";
import { SubAgentRouter } from "./services/sub-agent-router.js";
import { CodingWorkspaceService } from "./services/workspace-service.js";

export const agentOrchestratorPlugin: Plugin = {
  name: "@elizaos/plugin-agent-orchestrator",
  description:
    "Spawn and orchestrate coding agents via the Agent Client Protocol (acpx) with workspace lifecycle, GitHub integration, task history, sub-agent routing, and skill-recommender support. Single TASKS parent action covers create / spawn_agent / send / stop_agent / list_agents / cancel / history / control / share / provision_workspace / submit_workspace / manage_issues / archive / reopen.",
  // Services manage ACPX subprocesses, PTY sessions (legacy), workspaces, and sub-agent routing
  services: [
    AcpService as unknown as ServiceClass,
    SubAgentRouter as unknown as ServiceClass,
    // biome-ignore lint/suspicious/noExplicitAny: legacy PTY/workspace services don't extend Service base class
    PTYService as any,
    // biome-ignore lint/suspicious/noExplicitAny: legacy PTY/workspace services don't extend Service base class
    CodingWorkspaceService as any,
  ],
  actions: [tasksAction],
  evaluators: [],
  providers: [
    availableAgentsProvider, // Adapter inventory + raw session list
    activeSubAgentsProvider, // Cache-stable view of routed sub-agent sessions
    activeWorkspaceContextProvider, // Live workspace/session state
    codingAgentExamplesProvider, // Structured action call examples
  ],
};

export const taskAgentPlugin = agentOrchestratorPlugin;
export const codingAgentPlugin = agentOrchestratorPlugin;
export const acpPlugin = agentOrchestratorPlugin;

export default agentOrchestratorPlugin;

// Re-export coding agent adapter types (legacy orchestrator surface)
export type {
  AdapterType,
  AgentCredentials,
  AgentFileDescriptor,
  ApprovalConfig,
  ApprovalPreset as AdapterApprovalPreset,
  PreflightResult,
  PresetDefinition,
  RiskLevel,
  ToolCategory,
  WriteMemoryOptions,
} from "coding-agent-adapters";

// Canonical TASKS surface plus back-compat aliases for old action variable
// imports (every alias resolves to `tasksAction`).
export {
  archiveCodingTaskAction,
  cancelTaskAction,
  createTaskAction,
  finalizeWorkspaceAction,
  listAgentsAction,
  listTaskAgentsAction,
  manageIssuesAction,
  provisionWorkspaceAction,
  reopenCodingTaskAction,
  sendToAgentAction,
  sendToTaskAgentAction,
  spawnAgentAction,
  spawnTaskAgentAction,
  startCodingTaskAction,
  stopAgentAction,
  stopTaskAgentAction,
  taskControlAction,
  taskHistoryAction,
  tasksAction,
  taskShareAction,
} from "./actions/tasks.js";
// API routes
export {
  createCodingAgentRouteHandler,
  createTaskAgentRouteHandler,
  handleCodingAgentRoutes,
} from "./api/routes.js";
// Providers
export { activeSubAgentsProvider } from "./providers/active-sub-agents.js";
export {
  acpAvailableAgentsProvider,
  availableAgentsProvider,
} from "./providers/available-agents.js";

// ACP service surface
export {
  AcpService,
  AcpService as AcpxSubprocessService,
} from "./services/acp-service.js";
// Legacy PTY service surface
export { cleanForChat } from "./services/ansi-utils.js";
export type {
  CodingAgentType,
  PTYServiceConfig,
  SessionEventName as PTYSessionEventName,
  SessionInfo as PTYSessionInfo,
  SpawnSessionOptions as PTYSpawnSessionOptions,
} from "./services/pty-service.js";
export { getCoordinator, PTYService } from "./services/pty-service.js";
export {
  AcpSessionStore,
  FileSessionStore,
  InMemorySessionStore,
  RuntimeDbSessionStore,
} from "./services/session-store.js";
export { SubAgentRouter } from "./services/sub-agent-router.js";
export type {
  AgentDecisionCallback,
  ChatMessageCallback,
  CoordinationDecision,
  PendingDecision,
  SupervisionLevel,
  SwarmCompleteCallback,
  SwarmEvent,
  TaskCompletionSummary,
  TaskContext,
  WsBroadcastCallback,
} from "./services/swarm-coordinator.js";
export { SwarmCoordinator } from "./services/swarm-coordinator.js";
export type {
  CoordinationLLMResponse,
  SharedDecision,
} from "./services/swarm-coordinator-prompts.js";
export {
  buildBlockedEventMessage,
  buildTurnCompleteEventMessage,
} from "./services/swarm-coordinator-prompts.js";
// ACP types
export type {
  AcpEventCallback,
  AcpJsonRpcMessage,
  AgentType,
  AgentType as CodingAgentTypeAcp,
  ApprovalPreset,
  AvailableAgentInfo,
  PromptResult,
  SendOptions,
  SessionEventCallback,
  SessionEventName,
  SessionInfo,
  SessionInfo as AcpxSessionInfo,
  SessionStatus,
  SpawnOptions,
  SpawnOptions as SpawnSessionOptions,
  SpawnResult,
} from "./services/types.js";
export type {
  AuthPromptCallback,
  CodingWorkspaceConfig,
  CommitOptions,
  ProvisionWorkspaceOptions,
  PushOptions,
  WorkspaceResult,
} from "./services/workspace-service.js";
export { CodingWorkspaceService } from "./services/workspace-service.js";

export type AcpxServiceConfig = Record<string, unknown>;
export type PTYServiceConfigShim = AcpxServiceConfig;
export type AcpPreflightResult = {
  ok: boolean;
  message?: string;
  installCommand?: string;
};
