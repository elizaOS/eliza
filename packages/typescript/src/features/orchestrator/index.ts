/**
 * Task agent orchestrator: PTY sessions, workspaces, and coding-agent routing.
 *
 * The implementation is split so the raw capability tree stays in
 * `base-plugin.ts`, while `patch-agent-orchestrator-plugin.ts` applies
 * deployment integration (action aliases, API routes, PTY patches).
 *
 * @module orchestrator
 */

import { finalizeWorkspaceAction } from "./actions/finalize-workspace.ts";
import {
	listAgentsAction,
	listTaskAgentsAction,
} from "./actions/list-agents.ts";
import { manageIssuesAction } from "./actions/manage-issues.ts";
import { provisionWorkspaceAction } from "./actions/provision-workspace.ts";
import {
	sendToAgentAction,
	sendToTaskAgentAction,
} from "./actions/send-to-agent.ts";
import {
	spawnAgentAction,
	spawnTaskAgentAction,
} from "./actions/spawn-agent.ts";
import {
	createTaskAction,
	startCodingTaskAction,
} from "./actions/start-coding-task.ts";
import { stopAgentAction, stopTaskAgentAction } from "./actions/stop-agent.ts";
import { taskControlAction } from "./actions/task-control.ts";
import { taskHistoryAction } from "./actions/task-history.ts";
import { taskShareAction } from "./actions/task-share.ts";
import {
	createTaskAgentRouteHandler,
	handleCodingAgentRoutes,
} from "./api/routes.ts";
import orchestratorPluginDefault, {
	codingAgentPlugin,
	createAgentOrchestratorPlugin,
	createCodingAgentRouteHandler,
	getCoordinator,
	taskAgentPlugin,
} from "./patch-agent-orchestrator-plugin.ts";
import { cleanForChat } from "./services/ansi-utils.ts";
import { PTYService } from "./services/pty-service.ts";
import { SwarmCoordinator } from "./services/swarm-coordinator.ts";
import {
	buildBlockedEventMessage,
	buildTurnCompleteEventMessage,
} from "./services/swarm-coordinator-prompts.ts";

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
export type {
	CoordinationLLMResponse,
	SharedDecision,
} from "./services/swarm-coordinator-prompts.ts";
export type {
	AuthPromptCallback,
	CodingWorkspaceConfig,
	CommitOptions,
	ProvisionWorkspaceOptions,
	PushOptions,
	WorkspaceResult,
} from "./services/workspace-service.ts";

// Keep live runtime bindings in this entrypoint. Bun has produced an empty
// subpath bundle for pure re-export-only files here, which breaks the public
// `@elizaos/core/orchestrator` surface at runtime.
export {
	buildBlockedEventMessage,
	buildTurnCompleteEventMessage,
	cleanForChat,
	codingAgentPlugin,
	createAgentOrchestratorPlugin,
	createCodingAgentRouteHandler,
	createTaskAction,
	createTaskAgentRouteHandler,
	finalizeWorkspaceAction,
	getCoordinator,
	handleCodingAgentRoutes,
	listAgentsAction,
	listTaskAgentsAction,
	manageIssuesAction,
	orchestratorPluginDefault as default,
	PTYService,
	provisionWorkspaceAction,
	SwarmCoordinator,
	sendToAgentAction,
	sendToTaskAgentAction,
	spawnAgentAction,
	spawnTaskAgentAction,
	startCodingTaskAction,
	stopAgentAction,
	stopTaskAgentAction,
	taskAgentPlugin,
	taskControlAction,
	taskHistoryAction,
	taskShareAction,
};
