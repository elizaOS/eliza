import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import type { RobloxService } from "../services/RobloxService";
import { ROBLOX_SERVICE_NAME, type RobloxExperienceInfo } from "../types";

const providerName = "roblox-game-state";

export const gameStateProvider: Provider = {
  name: providerName,
  description: "Provides information about the connected Roblox game/experience",

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<ProviderResult> => {
    try {
      const service = runtime.getService<RobloxService>(ROBLOX_SERVICE_NAME);
      if (!service) {
        return { text: "", data: {}, values: {} };
      }

      const client = service.getClient(runtime.agentId);
      if (!client) {
        return { text: "", data: {}, values: {} };
      }

      const config = client.getConfig();

      let experienceInfo: RobloxExperienceInfo | null = null;
      try {
        experienceInfo = await client.getExperienceInfo();
      } catch {
        experienceInfo = null;
      }

      const parts: string[] = [
        "## Roblox Game Connection",
        "",
        `- **Universe ID**: ${config.universeId}`,
      ];

      if (config.placeId) {
        parts.push(`- **Place ID**: ${config.placeId}`);
      }

      if (experienceInfo) {
        parts.push(`- **Experience Name**: ${experienceInfo.name}`);
        if (experienceInfo.playing !== undefined) {
          parts.push(`- **Active Players**: ${experienceInfo.playing}`);
        }
        if (experienceInfo.visits !== undefined) {
          parts.push(`- **Total Visits**: ${experienceInfo.visits.toLocaleString()}`);
        }
        parts.push(
          `- **Creator**: ${experienceInfo.creator.name} (${experienceInfo.creator.type})`
        );
      }

      parts.push(`- **Messaging Topic**: ${config.messagingTopic}`);

      if (config.dryRun) {
        parts.push("");
        parts.push("*Dry run mode is enabled - actions are simulated*");
      }

      return { text: parts.join("\n"), data: {}, values: {} };
    } catch (error) {
      runtime.logger.error({ error }, "Error in gameStateProvider");
      return { text: "", data: {}, values: {} };
    }
  },
};
