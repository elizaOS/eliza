/**
 * Task Agent Plugin for Eliza
 *
 * Provides orchestration capabilities for CLI-based task agents:
 * - PTY session management (spawn, control, monitor task agents)
 * - Git workspace provisioning (clone, branch, PR creation)
 * - GitHub issue management (create, list, update, close)
 * - Integration with Claude Code, Codex, Gemini CLI, Aider, Pi, etc.
 *
 * @module orchestrator
 */

import type { Plugin } from "../types/index.ts";
import { finalizeWorkspaceAction } from "./actions/finalize-workspace.ts";
import { listAgentsAction } from "./actions/list-agents.ts";
import { taskControlAction } from "./actions/task-control.ts";
import { taskHistoryAction } from "./actions/task-history.ts";
import { taskShareAction } from "./actions/task-share.ts";
// Actions - Issue management
import { manageIssuesAction } from "./actions/manage-issues.ts";
// Actions - Workspace management
import { provisionWorkspaceAction } from "./actions/provision-workspace.ts";
import { sendToAgentAction } from "./actions/send-to-agent.ts";
// Actions - PTY management
import { spawnAgentAction } from "./actions/spawn-agent.ts";
// Actions - Unified task launcher
import { startCodingTaskAction } from "./actions/start-coding-task.ts";
import { stopAgentAction } from "./actions/stop-agent.ts";
// Providers
import { codingAgentExamplesProvider } from "./providers/action-examples.ts";
import { activeWorkspaceContextProvider } from "./providers/active-workspace-context.ts";
// Services
import { PTYService } from "./services/pty-service.ts";
import { CodingWorkspaceService } from "./services/workspace-service.ts";

/** Raw plugin object; the shipped entry applies patches in `patch-agent-orchestrator-plugin.ts`. */
export const taskAgentPluginBase: Plugin = {
  name: "@elizaos/agent-orchestrator",
  description:
    "Orchestrate open-ended task agents (Claude Code, Codex, Gemini CLI, Aider, Pi, etc.) via PTY sessions, " +
    "manage workspaces, track current task status, and keep background work moving while the main agent stays in conversation",

  // NOTE: init() is NOT reliably called by ElizaOS for workspace plugins.
  // SwarmCoordinator and auth callback wiring is done in PTYService.start()
  // which ElizaOS calls reliably via the services lifecycle.

  // Services manage PTY sessions and git workspaces
  // biome-ignore lint/suspicious/noExplicitAny: ElizaOS Plugin type expects Service[] but our classes don't extend their base Service
  services: [PTYService as any, CodingWorkspaceService as any],

  // Actions expose capabilities to the agent
  actions: [
    // Unified task launcher (provision + spawn in one step)
    startCodingTaskAction,
    // PTY session management (for direct control)
    spawnAgentAction,
    sendToAgentAction,
    stopAgentAction,
    listAgentsAction,
    taskHistoryAction,
    taskControlAction,
    taskShareAction,
    // Workspace management
    provisionWorkspaceAction,
    finalizeWorkspaceAction,
    // Issue management
    manageIssuesAction,
  ],

  // No evaluators needed for now
  evaluators: [],

  // Providers inject context into the prompt
  providers: [
    activeWorkspaceContextProvider, // Live workspace/session state
    codingAgentExamplesProvider, // Structured action call examples
  ],
};

export const codingAgentPluginBase = taskAgentPluginBase;

export default taskAgentPluginBase;

/** @public Factory matching other internal capability plugins (advanced-memory, etc.). */
export function createAgentOrchestratorPluginBase(): Plugin {
  return taskAgentPluginBase;
}

// Re-export coding agent adapter types
export type {
  AdapterType,
  AgentCredentials,
  AgentFileDescriptor,
  ApprovalConfig,
  ApprovalPreset,
  PreflightResult,
  PresetDefinition,
  RiskLevel,
  ToolCategory,
  WriteMemoryOptions,
} from "coding-agent-adapters";
export { finalizeWorkspaceAction } from "./actions/finalize-workspace.ts";
export { listAgentsAction } from "./actions/list-agents.ts";
export { manageIssuesAction } from "./actions/manage-issues.ts";
export { provisionWorkspaceAction } from "./actions/provision-workspace.ts";
export { sendToAgentAction } from "./actions/send-to-agent.ts";
export { spawnAgentAction } from "./actions/spawn-agent.ts";
export { taskControlAction } from "./actions/task-control.ts";
export { taskHistoryAction } from "./actions/task-history.ts";
export { taskShareAction } from "./actions/task-share.ts";
export { createTaskAction } from "./actions/start-coding-task.ts";
export { listTaskAgentsAction } from "./actions/list-agents.ts";
export { sendToTaskAgentAction } from "./actions/send-to-agent.ts";
export { spawnTaskAgentAction } from "./actions/spawn-agent.ts";
// Re-export actions
export { startCodingTaskAction } from "./actions/start-coding-task.ts";
export { stopAgentAction } from "./actions/stop-agent.ts";
export { stopTaskAgentAction } from "./actions/stop-agent.ts";
// Re-export API routes for server integration
export {
  createCodingAgentRouteHandler,
  createTaskAgentRouteHandler,
  handleCodingAgentRoutes,
} from "./api/routes.ts";
// Re-export service types
export type {
  CodingAgentType,
  PTYServiceConfig,
  SessionEventName,
  SessionInfo,
  SpawnSessionOptions,
} from "./services/pty-service.ts";
// Re-export services for direct access
export { getCoordinator, PTYService } from "./services/pty-service.ts";
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
} from "./services/swarm-coordinator.ts";
export { SwarmCoordinator } from "./services/swarm-coordinator.ts";
export type { CoordinationLLMResponse, SharedDecision } from "./services/swarm-coordinator-prompts.ts";
export {
  buildBlockedEventMessage,
  buildTurnCompleteEventMessage,
} from "./services/swarm-coordinator-prompts.ts";
export type {
  AuthPromptCallback,
  CodingWorkspaceConfig,
  CommitOptions,
  ProvisionWorkspaceOptions,
  PushOptions,
  WorkspaceResult,
} from "./services/workspace-service.ts";
export { CodingWorkspaceService } from "./services/workspace-service.ts";
