import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import type { ComputerUseService } from "../services/computeruse-service.js";

export const computeruseStateProvider: Provider = {
  name: "COMPUTERUSE_STATE",
  description: "Provides current ComputerUse backend/mode information",
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> => {
    const service = runtime.getService<ComputerUseService>("computeruse");
    if (!service || !service.isEnabled()) {
      return {
        text: "ComputerUse is disabled",
        values: { enabled: false },
        data: { enabled: false },
      };
    }

    const backend = service.getBackendName();
    const mode = service.getMode();
    const mcpServer = service.getMcpServerName();

    return {
      text: `ComputerUse enabled. Mode=${mode}. Backend=${backend ?? "none"}. Platform=${process.platform}.`,
      values: {
        enabled: true,
        mode,
        backend: backend ?? "none",
        platform: process.platform,
        mcpServer,
      },
      data: {
        enabled: true,
        mode,
        backend,
        platform: process.platform,
        mcpServer,
      },
    };
  },
};
