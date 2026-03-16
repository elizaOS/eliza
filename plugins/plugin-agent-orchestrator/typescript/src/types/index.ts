/**
 * Type definitions for the agent orchestrator plugin.
 *
 * @module types
 */

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
} from "./subagent.js";

export { SubagentEventType } from "./subagent.js";

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
} from "./sandbox.js";

export { SandboxEventType } from "./sandbox.js";

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
} from "./messaging.js";

export { MessagingEventType } from "./messaging.js";
