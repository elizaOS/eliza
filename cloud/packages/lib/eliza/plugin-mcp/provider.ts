import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import type { McpService } from "./service";
import { MCP_SERVICE_NAME } from "./types";

const EMPTY_PROVIDER = {
  values: { mcp: {} },
  data: { mcp: {} },
  text: "No MCP servers available.",
};

export const provider: Provider = {
  name: "MCP",
  description: "Connected MCP servers, tools, and resources",

  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    const svc = runtime.getService<McpService>(MCP_SERVICE_NAME);
    if (!svc) return EMPTY_PROVIDER;
    await svc.waitForInitialization();
    return svc.getProviderData();
  },
};
