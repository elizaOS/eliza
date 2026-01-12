import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import { logger, ServiceType } from "@elizaos/core";
import type { BrowserService } from "../services/browser-service.js";

export const browserStateProvider: Provider = {
  name: "BROWSER_STATE",
  description: "Provides current browser state information",

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<ProviderResult> => {
    const service = runtime.getService<BrowserService>(ServiceType.BROWSER);
    const session = await service?.getCurrentSession();

    if (!session || !service) {
      return {
        text: "No active browser session",
        values: {
          hasSession: false,
        },
        data: {},
      };
    }

    try {
      const client = service.getClient();
      const state = await client.getState(session.id);

      return {
        text: `Current browser page: "${state.title}" at ${state.url}`,
        values: {
          hasSession: true,
          url: state.url,
          title: state.title,
        },
        data: {
          sessionId: session.id,
          createdAt: session.createdAt.toISOString(),
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Error getting browser state: ${errorMessage}`);
      return {
        text: "Error getting browser state",
        values: {
          hasSession: true,
          error: true,
        },
        data: {},
      };
    }
  },
};
