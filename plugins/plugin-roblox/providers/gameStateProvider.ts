import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import type { RobloxService } from "../services/RobloxService";
import { ROBLOX_SERVICE_NAME, type RobloxExperienceInfo } from "../types";

const providerName = "roblox-game-state";
const EXPERIENCE_NAME_LIMIT = 160;

export const gameStateProvider: Provider = {
  name: providerName,
  description: "Provides information about the connected Roblox game/experience",
  descriptionCompressed: "Read Roblox connection state, experience metadata, and messaging topic.",
  contexts: ["automation", "agent_internal"],
  contextGate: { anyOf: ["automation", "agent_internal"] },
  cacheStable: false,
  cacheScope: "turn",
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<ProviderResult> => {
    const apiKeyConfigured = Boolean(runtime.getSetting("ROBLOX_API_KEY"));
    const universeIdSetting = runtime.getSetting("ROBLOX_UNIVERSE_ID");
    const universeId = typeof universeIdSetting === "string" ? universeIdSetting : undefined;
    const configured = apiKeyConfigured && Boolean(universeId);

    try {
      const service = runtime.getService<RobloxService>(ROBLOX_SERVICE_NAME);
      if (!service) {
        return {
          text: [
            "Roblox:",
            `configured: ${configured}`,
            "service: unavailable",
            `apiKey: ${apiKeyConfigured ? "configured" : "missing"}`,
            `universeId: ${universeId ?? "missing"}`,
          ].join("\n"),
          data: {
            configured,
            apiKeyConfigured,
            universeId: universeId ?? null,
            serviceAvailable: false,
            clientAvailable: false,
          },
          values: {
            configured,
            serviceAvailable: false,
            clientAvailable: false,
          },
        };
      }

      const client = service.getClient(runtime.agentId);
      if (!client) {
        return {
          text: [
            "Roblox:",
            `configured: ${configured}`,
            "service: available",
            "client: unavailable",
            `apiKey: ${apiKeyConfigured ? "configured" : "missing"}`,
            `universeId: ${universeId ?? "missing"}`,
          ].join("\n"),
          data: {
            configured,
            apiKeyConfigured,
            universeId: universeId ?? null,
            serviceAvailable: true,
            clientAvailable: false,
          },
          values: {
            configured,
            serviceAvailable: true,
            clientAvailable: false,
          },
        };
      }

      const config = client.getConfig();

      let experienceInfo: RobloxExperienceInfo | null = null;
      try {
        experienceInfo = await client.getExperienceInfo();
      } catch {
        experienceInfo = null;
      }

      const parts: string[] = [
        "Roblox:",
        "configured: true",
        "service: available",
        "client: available",
        `universeId: ${config.universeId}`,
      ];

      if (config.placeId) {
        parts.push(`placeId: ${config.placeId}`);
      }

      if (experienceInfo) {
        parts.push(`experienceName: ${experienceInfo.name.slice(0, EXPERIENCE_NAME_LIMIT)}`);
        if (experienceInfo.playing !== undefined) {
          parts.push(`activePlayers: ${experienceInfo.playing}`);
        }
        if (experienceInfo.visits !== undefined) {
          parts.push(`totalVisits: ${experienceInfo.visits}`);
        }
        parts.push(`creator: ${experienceInfo.creator.name} (${experienceInfo.creator.type})`);
      } else {
        parts.push("experience: unavailable");
      }

      parts.push(`messagingTopic: ${config.messagingTopic}`);

      if (config.dryRun) {
        parts.push("dryRun: true");
      }

      return {
        text: parts.join("\n"),
        data: {
          configured: true,
          serviceAvailable: true,
          clientAvailable: true,
          universeId: config.universeId,
          placeId: config.placeId ?? null,
          messagingTopic: config.messagingTopic,
          dryRun: config.dryRun,
          experienceInfo,
        },
        values: {
          configured: true,
          serviceAvailable: true,
          clientAvailable: true,
          universeId: config.universeId,
          placeId: config.placeId ?? null,
          messagingTopic: config.messagingTopic,
          dryRun: config.dryRun,
          experienceName: experienceInfo?.name ?? null,
          activePlayers: experienceInfo?.playing ?? null,
        },
      };
    } catch (error) {
      runtime.logger.error({ error }, "Error in gameStateProvider");
      const message = error instanceof Error ? error.message : String(error);
      return {
        text: `Roblox provider error: ${message}`,
        data: { configured, error: message },
        values: { configured, error: true },
      };
    }
  },
};
