/**
 * Task agent orchestrator: PTY sessions, workspaces, and coding-agent routing.
 *
 * The implementation is split so the raw capability tree stays in
 * `base-plugin.ts`, while `patch-agent-orchestrator-plugin.ts` applies
 * deployment integration (action aliases, API routes, PTY patches).
 *
 * @module orchestrator
 */

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
export { startCodingTaskAction } from "./actions/start-coding-task.ts";
export { stopAgentAction } from "./actions/stop-agent.ts";
export { stopTaskAgentAction } from "./actions/stop-agent.ts";
export {
  createTaskAgentRouteHandler,
  handleCodingAgentRoutes,
} from "./api/routes.ts";
export type {
  CodingAgentType,
  PTYServiceConfig,
  SessionEventName,
  SessionInfo,
  SpawnSessionOptions,
} from "./services/pty-service.ts";
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

export {
  codingAgentPlugin,
  CodingWorkspaceService,
  createAgentOrchestratorPlugin,
  createCodingAgentRouteHandler,
  default,
  getCoordinator,
  PTYService,
  taskAgentPlugin,
} from "./patch-agent-orchestrator-plugin.ts";
