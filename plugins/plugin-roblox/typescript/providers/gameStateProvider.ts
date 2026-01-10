/**
 * Provider for Roblox game state information
 */

import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { RobloxService } from "../services/RobloxService";
import { ROBLOX_SERVICE_NAME } from "../types";

/**
 * Provider that supplies Roblox game state to the agent context
 */
export const gameStateProvider: Provider = {
  name: "roblox-game-state",
  description: "Provides information about the connected Roblox game/experience",

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<string | null> => {
    try {
      const service = runtime.getService<RobloxService>(ROBLOX_SERVICE_NAME);
      if (!service) {
        return null;
      }

      const client = service.getClient(runtime.agentId);
      if (!client) {
        return null;
      }

      const config = client.getConfig();

      // Try to get experience info
      let experienceInfo;
      try {
        experienceInfo = await client.getExperienceInfo();
      } catch {
        // Experience info might not be available
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
        parts.push(`- **Creator**: ${experienceInfo.creator.name} (${experienceInfo.creator.type})`);
      }

      parts.push(`- **Messaging Topic**: ${config.messagingTopic}`);

      if (config.dryRun) {
        parts.push("");
        parts.push("*Note: Dry run mode is enabled - actions are simulated*");
      }

      return parts.join("\n");
    } catch (error) {
      runtime.logger.error({ error }, "Error in gameStateProvider");
      return null;
    }
  },
};

