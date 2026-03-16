import type { Plugin } from "@elizaos/core";
import { getSessionProviders } from "@elizaos/core";
import {
  cancelTaskAction,
  createTaskAction,
  listTasksAction,
  pauseTaskAction,
  resumeTaskAction,
  searchTasksAction,
  switchTaskAction,
} from "./src/actions/task-management.js";
import {
  cancelSubagentAction,
  getSubagentStatusAction,
  listSubagentsAction,
  sendToSessionAction,
  spawnSubagentAction,
} from "./src/actions/subagent-management.js";
import {
  listMessagingChannelsAction,
  sendCrossPlatformMessageAction,
  sendToDeliveryContextAction,
  sendToRoomAction,
  sendToSessionMessageAction,
} from "./src/actions/messaging.js";
import {
  configureAgentOrchestratorPlugin,
  getConfiguredAgentOrchestratorOptions,
} from "./src/config.js";
import { taskContextProvider } from "./src/providers/task-context.js";
import { orchestratorConfigProvider } from "./src/providers/orchestrator-config.js";
import { AgentOrchestratorService } from "./src/services/agent-orchestrator-service.js";
import { SubagentService } from "./src/services/subagent-service.js";
import { SandboxService } from "./src/services/sandbox-service.js";
import { MessagingService } from "./src/services/messaging-service.js";

export { configureAgentOrchestratorPlugin, getConfiguredAgentOrchestratorOptions };

// Get session providers from core (session context, skills, send policy)
const sessionProviders = getSessionProviders();

export const agentOrchestratorPlugin: Plugin = {
  name: "agent-orchestrator",
  description:
    "Orchestrate tasks across agent providers with subagent spawning, agent-to-agent communication, sandboxed execution, and cross-platform messaging",
  services: [AgentOrchestratorService, SubagentService, SandboxService, MessagingService],
  providers: [taskContextProvider, orchestratorConfigProvider, ...sessionProviders],
  actions: [
    // Task management
    createTaskAction,
    listTasksAction,
    switchTaskAction,
    searchTasksAction,
    pauseTaskAction,
    resumeTaskAction,
    cancelTaskAction,
    // Subagent management
    spawnSubagentAction,
    sendToSessionAction,
    listSubagentsAction,
    cancelSubagentAction,
    getSubagentStatusAction,
    // Cross-platform messaging
    sendCrossPlatformMessageAction,
    sendToDeliveryContextAction,
    sendToRoomAction,
    sendToSessionMessageAction,
    listMessagingChannelsAction,
  ],
};

export default agentOrchestratorPlugin;

// Task management actions
export {
  cancelTaskAction,
  createTaskAction,
  listTasksAction,
  pauseTaskAction,
  resumeTaskAction,
  searchTasksAction,
  switchTaskAction,
} from "./src/actions/task-management.js";

// Subagent management actions
export {
  cancelSubagentAction,
  getSubagentStatusAction,
  listSubagentsAction,
  sendToSessionAction,
  spawnSubagentAction,
} from "./src/actions/subagent-management.js";

// Messaging actions
export {
  listMessagingChannelsAction,
  sendCrossPlatformMessageAction,
  sendToDeliveryContextAction,
  sendToRoomAction,
  sendToSessionMessageAction,
} from "./src/actions/messaging.js";

// Services
export { AgentOrchestratorService } from "./src/services/agent-orchestrator-service.js";
export { SubagentService } from "./src/services/subagent-service.js";
export { SandboxService } from "./src/services/sandbox-service.js";
export { MessagingService } from "./src/services/messaging-service.js";

// Task types
export type {
  AgentOrchestratorPluginOptions,
  AgentProvider,
  AgentProviderId,
  OrchestratedTask,
  OrchestratedTaskMetadata,
  ProviderTaskExecutionContext,
  TaskEvent,
  TaskEventType,
  TaskResult,
  TaskStatus,
  TaskStep,
  TaskUserStatus,
} from "./src/types.js";

// Subagent types
export type {
  AgentToAgentPolicy,
  DeliveryContext,
  ParsedSessionKey,
  SendToAgentParams,
  SendToAgentResult,
  SpawnSubagentParams,
  SpawnSubagentResult,
  SubagentConfig,
  SubagentEventPayload,
  SubagentRoomMetadata,
  SubagentRunOutcome,
  SubagentRunRecord,
} from "./src/types/index.js";

export { SubagentEventType } from "./src/types/index.js";

// Sandbox types
export type {
  SandboxBrowserConfig,
  SandboxBrowserContext,
  SandboxConfig,
  SandboxContext,
  SandboxDockerConfig,
  SandboxEventPayload,
  SandboxExecuteParams,
  SandboxExecutionResult,
  SandboxMode,
  SandboxPruneConfig,
  SandboxScope,
  SandboxToolPolicy,
  SandboxWorkspaceAccess,
  SandboxWorkspaceInfo,
} from "./src/types/index.js";

export { SandboxEventType } from "./src/types/index.js";

// Messaging types
export type {
  DeliveryStatus,
  MessageAttachment,
  MessageButton,
  MessageContent,
  MessageEmbed,
  MessageTarget,
  MessagingAdapter,
  MessagingChannel,
  MessagingEventPayload,
  MessagingRoomMetadata,
  SendMessageParams,
  SendMessageResult,
} from "./src/types/index.js";

export { MessagingEventType } from "./src/types/index.js";

// Config provider
export {
  getOrchestratorConfig,
  orchestratorConfigProvider,
  type OrchestratorConfig,
} from "./src/providers/orchestrator-config.js";

// Session utilities (orchestrator-specific)
export {
  buildSessionKey,
  createSubagentSessionKey,
  extractAgentIdFromSessionKey,
  formatDurationShort,
  formatTokenCount,
  hashToUUID,
  isSubagentSessionKey,
  mergeDeliveryContext,
  normalizeAgentId,
  normalizeDeliveryContext,
  normalizeSessionKey,
  parseSessionKey,
  sessionKeyToRoomId,
} from "./src/utils/index.js";

// Core session utilities (re-exported from @elizaos/core)
export {
  // Session key building/parsing
  buildAgentMainSessionKey,
  buildAgentSessionKey,
  buildAgentPeerSessionKey,
  buildAcpSessionKey,
  buildSubagentSessionKey,
  parseAgentSessionKey,
  isAcpSessionKey,
  isCoreSubagentSessionKey,
  normalizeCoreAgentId,
  normalizeMainKey,
  normalizeAccountId,
  toAgentRequestSessionKey,
  toAgentStoreSessionKey,
  resolveAgentIdFromSessionKey,
  resolveThreadParentSessionKey,
  resolveThreadSessionKeys,
  buildGroupHistoryKey,
  // Session types
  type SessionEntry,
  type SessionStore,
  type SessionDeliveryContext,
  type SessionResolution,
  // Session store operations
  loadSessionStore,
  saveSessionStore,
  updateSessionStore,
  updateSessionStoreEntry,
  getSessionEntry,
  upsertSessionEntry,
  deleteSessionEntry,
  listSessionKeys,
  // Session paths
  resolveStateDir,
  resolveAgentSessionsDir,
  resolveDefaultSessionStorePath,
  resolveSessionTranscriptPath,
  resolveStorePath,
  // Session providers
  createSessionProvider,
  createSessionSkillsProvider,
  createSendPolicyProvider,
  getSessionProviders,
  extractSessionContext,
  SessionStateManager,
  // Session entry utilities
  createSessionEntry,
  mergeSessionEntry,
  isValidSessionEntry,
} from "./src/utils/index.js";
