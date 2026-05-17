import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import type { McpService } from "./service";
import { MCP_SERVICE_NAME } from "./types";

const MAX_MCP_TEXT_CHARS = 4000;

const EMPTY_PROVIDER = {
  values: { mcp: {} },
  data: { mcp: {} },
  text: "No MCP servers available.",
};

export const provider: Provider = {
  name: "MCP",
  description: "Connected MCP servers, tools, and resources",
  contexts: ["connectors", "settings"],
  contextGate: { anyOf: ["connectors", "settings"] },
  cacheStable: false,
  cacheScope: "turn",
  roleGate: { minRole: "USER" },

  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    try {
      const svc = runtime.getService<McpService>(MCP_SERVICE_NAME);
      if (!svc) return EMPTY_PROVIDER;
      await svc.waitForInitialization();
      const result = await svc.getProviderData();
      const text = (result.text ?? "").slice(0, MAX_MCP_TEXT_CHARS);
      return {
        text,
        values: result.values ?? { mcp: {} },
        data: result.data ?? { mcp: {} },
      };
    } catch (error) {
      return {
        text: "MCP provider unavailable.",
        values: { mcp: {}, mcpError: true },
        data: {
          mcp: {},
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  },
};
