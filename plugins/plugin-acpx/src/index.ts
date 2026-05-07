import type { Plugin, ServiceClass } from "@elizaos/core";
import { cancelTaskAction } from "./actions/cancel-task.js";
import { createTaskAction } from "./actions/create-task.js";
import { listAgentsAction } from "./actions/list-agents.js";
import { sendToAgentAction } from "./actions/send-to-agent.js";
import { spawnAgentAction } from "./actions/spawn-agent.js";
import { stopAgentAction } from "./actions/stop-agent.js";
import { availableAgentsProvider } from "./providers/available-agents.js";
import { AcpService } from "./services/acp-service.js";

export const acpPlugin: Plugin = {
  name: "@elizaos/plugin-acpx",
  description:
    "Canonical ElizaOS ACPX plugin for spawning and orchestrating coding agents via Agent Client Protocol",
  actions: [
    createTaskAction,
    spawnAgentAction,
    sendToAgentAction,
    stopAgentAction,
    listAgentsAction,
    cancelTaskAction,
  ],
  providers: [availableAgentsProvider],
  services: [AcpService as unknown as ServiceClass],
};

export const taskAgentPlugin = acpPlugin;
export const codingAgentPlugin = acpPlugin;
export const agentOrchestratorPlugin = acpPlugin;

export default acpPlugin;

export { cancelTaskAction } from "./actions/cancel-task.js";
export {
  createTaskAction,
  startCodingTaskAction,
} from "./actions/create-task.js";
export {
  listAgentsAction,
  listTaskAgentsAction,
} from "./actions/list-agents.js";
export {
  sendToAgentAction,
  sendToTaskAgentAction,
} from "./actions/send-to-agent.js";
export {
  spawnAgentAction,
  spawnTaskAgentAction,
} from "./actions/spawn-agent.js";
export { stopAgentAction, stopTaskAgentAction } from "./actions/stop-agent.js";
export {
  acpAvailableAgentsProvider,
  availableAgentsProvider,
} from "./providers/available-agents.js";

export {
  AcpService,
  AcpService as AcpxSubprocessService,
  AcpService as PTYService,
} from "./services/acp-service.js";
export {
  AcpSessionStore,
  FileSessionStore,
  InMemorySessionStore,
  RuntimeDbSessionStore,
} from "./services/session-store.js";

export type {
  AcpEventCallback,
  AcpJsonRpcMessage,
  AgentType,
  AgentType as AdapterType,
  AgentType as CodingAgentType,
  ApprovalPreset,
  AvailableAgentInfo,
  PromptResult,
  SendOptions,
  SessionEventCallback,
  SessionEventName,
  SessionInfo,
  SessionInfo as AcpxSessionInfo,
  SessionInfo as AcpxSessionInfoCompat,
  SessionStatus,
  SpawnOptions,
  SpawnOptions as SpawnSessionOptions,
  SpawnResult,
} from "./services/types.js";

export type AcpxServiceConfig = Record<string, unknown>;
export type PTYServiceConfig = AcpxServiceConfig;
export type AgentCredentials = Record<string, unknown>;
export type AcpPreflightResult = {
  ok: boolean;
  message?: string;
  installCommand?: string;
};
export type PreflightResult = AcpPreflightResult;

export function getCoordinator(): undefined {
  return undefined;
}
