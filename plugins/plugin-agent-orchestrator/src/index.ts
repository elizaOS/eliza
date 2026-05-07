/**
 * Task Agent Plugin for Eliza
 *
 * Provides orchestration capabilities for CLI-based task agents:
 * - PTY session management (spawn, control, monitor task agents)
 * - Git workspace provisioning (clone, branch, PR creation)
 * - GitHub issue management (create, list, update, close)
 * - Integration with Claude Code, Codex, Gemini CLI, Aider, Pi, etc.
 *
 * @module @elizaos/plugin-agent-orchestrator
 */

import type { Plugin } from "@elizaos/core";
// Side-effect: register coding-agent HTTP routes with the runtime route registry.
import "./register-routes.js";
import { finalizeWorkspaceAction } from "./actions/finalize-workspace.js";
// Actions - Issue management
import { manageIssuesAction } from "./actions/manage-issues.js";
// Actions - Workspace management
import { provisionWorkspaceAction } from "./actions/provision-workspace.js";
import { sendToAgentAction } from "./actions/send-to-agent.js";
// Actions - PTY management
import { spawnAgentAction } from "./actions/spawn-agent.js";
// Actions - Task launcher
import { startCodingTaskAction } from "./actions/start-coding-task.js";
import { stopAgentAction } from "./actions/stop-agent.js";
import { taskControlAction } from "./actions/task-control.js";
import { taskHistoryAction } from "./actions/task-history.js";
import { taskShareAction } from "./actions/task-share.js";
// Providers
import { codingAgentExamplesProvider } from "./providers/action-examples.js";
import { activeWorkspaceContextProvider } from "./providers/active-workspace-context.js";
// Services
import { PTYService } from "./services/pty-service.js";
import { CodingWorkspaceService } from "./services/workspace-service.js";

export const taskAgentPlugin: Plugin = {
  name: "@elizaos/plugin-agent-orchestrator",
  description:
    "Orchestrate open-ended task agents (Claude Code, Codex, Gemini CLI, Aider, Pi, etc.) via PTY sessions, " +
    "manage workspaces, track current task status, and keep background work moving while the main agent stays in conversation",

  // SwarmCoordinator and auth callback wiring is done in PTYService.start()
  // which ElizaOS calls reliably via the services lifecycle.

  // Services manage PTY sessions and git workspaces
  // biome-ignore lint/suspicious/noExplicitAny: ElizaOS Plugin type expects Service[] but our classes don't extend their base Service
  services: [PTYService as any, CodingWorkspaceService as any],

  // Actions expose capabilities to the agent
  actions: [
    // Task launcher (provision + spawn in one step)
    startCodingTaskAction,
    // PTY session management (for direct control)
    spawnAgentAction,
    sendToAgentAction,
    stopAgentAction,
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

export const codingAgentPlugin = taskAgentPlugin;
export const agentOrchestratorPlugin = taskAgentPlugin;

export default taskAgentPlugin;

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
export { finalizeWorkspaceAction } from "./actions/finalize-workspace.js";
export {
  listAgentsAction,
  listTaskAgentsAction,
} from "./actions/list-agents.js";
export { manageIssuesAction } from "./actions/manage-issues.js";
export { provisionWorkspaceAction } from "./actions/provision-workspace.js";
export {
  sendToAgentAction,
  sendToTaskAgentAction,
} from "./actions/send-to-agent.js";
export {
  spawnAgentAction,
  spawnTaskAgentAction,
} from "./actions/spawn-agent.js";
// Re-export actions
export { startCodingTaskAction } from "./actions/start-coding-task.js";
export { stopAgentAction, stopTaskAgentAction } from "./actions/stop-agent.js";
export { taskControlAction } from "./actions/task-control.js";
export { taskHistoryAction } from "./actions/task-history.js";
export { taskShareAction } from "./actions/task-share.js";
// Re-export API routes for server integration
export {
  createCodingAgentRouteHandler,
  createTaskAgentRouteHandler,
  handleCodingAgentRoutes,
} from "./api/routes.js";
export { cleanForChat } from "./services/ansi-utils.js";
// Re-export service types
export type {
  CodingAgentType,
  PTYServiceConfig,
  SessionEventName,
  SessionInfo,
  SpawnSessionOptions,
} from "./services/pty-service.js";
// Re-export services for direct access
export { getCoordinator, PTYService } from "./services/pty-service.js";
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
export type {
  AuthPromptCallback,
  CodingWorkspaceConfig,
  CommitOptions,
  ProvisionWorkspaceOptions,
  PushOptions,
  WorkspaceResult,
} from "./services/workspace-service.js";
export { CodingWorkspaceService } from "./services/workspace-service.js";
