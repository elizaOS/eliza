import type { Plugin } from "@elizaos/core";
import { getSessionProviders } from "@elizaos/core";
import {
  listMessagingChannelsAction,
  sendCrossPlatformMessageAction,
  sendToDeliveryContextAction,
  sendToRoomAction,
  sendToSessionMessageAction,
} from "./src/actions/messaging.js";
import {
  cancelSubagentAction,
  getSubagentStatusAction,
  listSubagentsAction,
  sendToSessionAction,
  spawnSubagentAction,
} from "./src/actions/subagent-management.js";
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
  configureAgentOrchestratorPlugin,
  getConfiguredAgentOrchestratorOptions,
} from "./src/config.js";
import { orchestratorConfigProvider } from "./src/providers/orchestrator-config.js";
import { taskContextProvider } from "./src/providers/task-context.js";
import { AgentOrchestratorService } from "./src/services/agent-orchestrator-service.js";
import { MessagingService } from "./src/services/messaging-service.js";
import { SandboxService } from "./src/services/sandbox-service.js";
import { SubagentService } from "./src/services/subagent-service.js";

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

// Messaging actions
export {
  listMessagingChannelsAction,
  sendCrossPlatformMessageAction,
  sendToDeliveryContextAction,
  sendToRoomAction,
  sendToSessionMessageAction,
} from "./src/actions/messaging.js";

// Subagent management actions
export {
  cancelSubagentAction,
  getSubagentStatusAction,
  listSubagentsAction,
  sendToSessionAction,
  spawnSubagentAction,
} from "./src/actions/subagent-management.js";
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
// Config provider
export {
  getOrchestratorConfig,
  type OrchestratorConfig,
  orchestratorConfigProvider,
} from "./src/providers/orchestrator-config.js";
// Services
export { AgentOrchestratorService } from "./src/services/agent-orchestrator-service.js";
export { MessagingService } from "./src/services/messaging-service.js";
export { SandboxService } from "./src/services/sandbox-service.js";
export { SubagentService } from "./src/services/subagent-service.js";
// Subagent types
// Sandbox types
// Messaging types
export type {
  AgentToAgentPolicy,
  DeliveryContext,
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
  ParsedSessionKey,
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
  SendMessageParams,
  SendMessageResult,
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
export { MessagingEventType, SandboxEventType, SubagentEventType } from "./src/types/index.js";
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
// Session utilities (orchestrator-specific)
// Core session utilities (re-exported from @elizaos/core)
export {
  buildAcpSessionKey,
  // Session key building/parsing
  buildAgentMainSessionKey,
  buildAgentPeerSessionKey,
  buildAgentSessionKey,
  buildGroupHistoryKey,
  buildSessionKey,
  buildSubagentSessionKey,
  createSendPolicyProvider,
  // Session entry utilities
  createSessionEntry,
  // Session providers
  createSessionProvider,
  createSessionSkillsProvider,
  createSubagentSessionKey,
  deleteSessionEntry,
  extractAgentIdFromSessionKey,
  extractSessionContext,
  formatDurationShort,
  formatTokenCount,
  getSessionEntry,
  getSessionProviders,
  hashToUUID,
  isAcpSessionKey,
  isCoreSubagentSessionKey,
  isSubagentSessionKey,
  isValidSessionEntry,
  listSessionKeys,
  // Session store operations
  loadSessionStore,
  mergeDeliveryContext,
  mergeSessionEntry,
  normalizeAccountId,
  normalizeAgentId,
  normalizeCoreAgentId,
  normalizeDeliveryContext,
  normalizeMainKey,
  normalizeSessionKey,
  parseAgentSessionKey,
  parseSessionKey,
  resolveAgentIdFromSessionKey,
  resolveAgentSessionsDir,
  resolveDefaultSessionStorePath,
  resolveSessionTranscriptPath,
  // Session paths
  resolveStateDir,
  resolveStorePath,
  resolveThreadParentSessionKey,
  resolveThreadSessionKeys,
  type SessionDeliveryContext,
  // Session types
  type SessionEntry,
  type SessionResolution,
  SessionStateManager,
  type SessionStore,
  saveSessionStore,
  sessionKeyToRoomId,
  toAgentRequestSessionKey,
  toAgentStoreSessionKey,
  updateSessionStore,
  updateSessionStoreEntry,
  upsertSessionEntry,
} from "./src/utils/index.js";
