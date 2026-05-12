import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { RobloxTestSuite } from "./__tests__/suite";
import { robloxActions } from "./actions";
import { robloxProviders } from "./providers";
import { RobloxService } from "./services/RobloxService";

export { RobloxApiError, RobloxClient } from "./client/RobloxClient";
export { RobloxService } from "./services/RobloxService";

export const robloxPlugin: Plugin = {
  name: "roblox",
  description: "Roblox game integration plugin for sending and receiving messages",
  services: [RobloxService],
  actions: robloxActions,
  providers: robloxProviders,
  tests: [new RobloxTestSuite()],

  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    const apiKey = runtime.getSetting("ROBLOX_API_KEY") as string;
    const universeId = runtime.getSetting("ROBLOX_UNIVERSE_ID") as string;

    if (!apiKey || apiKey.trim() === "") {
      runtime.logger.warn("ROBLOX_API_KEY not provided");
      return;
    }

    if (!universeId || universeId.trim() === "") {
      runtime.logger.warn("ROBLOX_UNIVERSE_ID not provided");
      return;
    }

    runtime.logger.info({ universeId }, "Roblox plugin initialized");
  },
};

export default robloxPlugin;
