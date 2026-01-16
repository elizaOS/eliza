import type { AgentOrchestratorPluginOptions } from "./types.js";

let globalOptions: AgentOrchestratorPluginOptions | null = null;

export function configureAgentOrchestratorPlugin(options: AgentOrchestratorPluginOptions): void {
  globalOptions = options;
}

export function getConfiguredAgentOrchestratorOptions(): AgentOrchestratorPluginOptions | null {
  return globalOptions;
}
