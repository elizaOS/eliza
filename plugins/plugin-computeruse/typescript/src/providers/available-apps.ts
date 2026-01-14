import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import type { ComputerUseService } from "../services/computeruse-service.js";

export const computeruseAvailableAppsProvider: Provider = {
  name: "COMPUTERUSE_AVAILABLE_APPS",
  description: "Lists currently running applications (best-effort, may be summarized in MCP mode)",
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> => {
    const service = runtime.getService<ComputerUseService>("computeruse");
    if (!service || !service.isEnabled()) {
      return {
        text: "ComputerUse is disabled",
        values: { enabled: false },
        data: { enabled: false },
      };
    }

    const apps = await service.getApplications();
    const text = `Running applications (${apps.length}):\n${apps.map((a) => `- ${a}`).join("\n")}`;

    return {
      text,
      values: { enabled: true, count: apps.length },
      data: { enabled: true, apps, count: apps.length, backend: service.getBackendName() },
    };
  },
};
