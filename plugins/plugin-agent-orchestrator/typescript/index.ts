import type { Plugin } from "@elizaos/core";
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
import { taskContextProvider } from "./src/providers/task-context.js";
import { AgentOrchestratorService } from "./src/services/agent-orchestrator-service.js";

export { configureAgentOrchestratorPlugin, getConfiguredAgentOrchestratorOptions };

export const agentOrchestratorPlugin: Plugin = {
  name: "agent-orchestrator",
  description: "Orchestrate tasks across one or more agent providers (no filesystem tools)",
  services: [AgentOrchestratorService],
  providers: [taskContextProvider],
  actions: [
    createTaskAction,
    listTasksAction,
    switchTaskAction,
    searchTasksAction,
    pauseTaskAction,
    resumeTaskAction,
    cancelTaskAction,
  ],
};

export default agentOrchestratorPlugin;

export {
  cancelTaskAction,
  createTaskAction,
  listTasksAction,
  pauseTaskAction,
  resumeTaskAction,
  searchTasksAction,
  switchTaskAction,
} from "./src/actions/task-management.js";
export { AgentOrchestratorService } from "./src/services/agent-orchestrator-service.js";
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
