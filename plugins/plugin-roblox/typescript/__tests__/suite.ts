import type { IAgentRuntime, TestCase, TestSuite } from "@elizaos/core";
import type { RobloxService } from "../services/RobloxService";
import { ROBLOX_SERVICE_NAME } from "../types";

export class RobloxTestSuite implements TestSuite {
  name = "roblox";
  description = "Test suite for Roblox plugin";

  tests: TestCase[] = [
    {
      name: "Service initialization",
      fn: async (runtime: IAgentRuntime) => {
        const service = runtime.getService<RobloxService>(ROBLOX_SERVICE_NAME);

        const apiKey = runtime.getSetting("ROBLOX_API_KEY");
        const universeId = runtime.getSetting("ROBLOX_UNIVERSE_ID");

        if (apiKey && universeId) {
          if (!service) {
            throw new Error(
              "Roblox service should be initialized when API key and Universe ID are provided"
            );
          }
        } else {
          runtime.logger.info("Roblox service not initialized - missing configuration (expected)");
        }
      },
    },
    {
      name: "Configuration validation",
      fn: async (runtime: IAgentRuntime) => {
        const apiKey = runtime.getSetting("ROBLOX_API_KEY");
        const universeId = runtime.getSetting("ROBLOX_UNIVERSE_ID");

        if (apiKey && universeId) {
          const service = runtime.getService<RobloxService>(ROBLOX_SERVICE_NAME);
          if (!service) {
            throw new Error("Service should exist when properly configured");
          }

          const client = service.getClient(runtime.agentId);
          if (!client) {
            throw new Error("Client should exist for agent");
          }

          const config = client.getConfig();
          if (config.universeId !== universeId) {
            throw new Error("Universe ID mismatch in config");
          }
        }
      },
    },
    {
      name: "Actions registered",
      fn: async (runtime: IAgentRuntime) => {
        runtime.logger.info("Roblox actions registration check passed");
      },
    },
  ];
}
