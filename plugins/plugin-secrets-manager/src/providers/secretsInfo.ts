import {
  type Provider,
  type IAgentRuntime,
  type Memory,
  type State,
  elizaLogger,
} from "@elizaos/core";
import { EnhancedSecretManager } from "../enhanced-service";
import type { SecretContext } from "../types";

export const secretsInfoProvider: Provider = {
  name: "secretsInfo",
  description:
    "Provides information about available secrets at different levels (global, world, user)",

  get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    elizaLogger.debug("[SecretsInfo] Fetching secrets information");

    const secretsService = runtime.getService(
      "SECRETS",
    ) as EnhancedSecretManager;
    if (!secretsService) {
      return {
        text: "Secrets management service is not available",
        values: {},
      };
    }

    try {
      const results: {
        global?: { count: number; keys: string[] };
        world?: { count: number; keys: string[] };
        user?: { count: number; keys: string[] };
      } = {};

      // Get global secrets (if user has access)
      try {
        const globalContext: SecretContext = {
          level: "global",
          agentId: runtime.agentId,
          requesterId: message.entityId,
        };
        const globalSecrets = await secretsService.list(globalContext);
        const globalKeys = Object.keys(globalSecrets);
        results.global = {
          count: globalKeys.length,
          keys: globalKeys,
        };
      } catch (error) {
        elizaLogger.debug(
          "[SecretsInfo] Could not fetch global secrets:",
          error,
        );
      }

      // Get world secrets
      if (message.roomId) {
        try {
          const worldContext: SecretContext = {
            level: "world",
            worldId: message.roomId,
            agentId: runtime.agentId,
            requesterId: message.entityId,
          };
          const worldSecrets = await secretsService.list(worldContext);
          const worldKeys = Object.keys(worldSecrets);
          results.world = {
            count: worldKeys.length,
            keys: worldKeys,
          };
        } catch (error) {
          elizaLogger.debug(
            "[SecretsInfo] Could not fetch world secrets:",
            error,
          );
        }
      }

      // Get user secrets
      try {
        const userContext: SecretContext = {
          level: "user",
          userId: message.entityId,
          agentId: runtime.agentId,
          requesterId: message.entityId,
        };
        const userSecrets = await secretsService.list(userContext);
        const userKeys = Object.keys(userSecrets);
        results.user = {
          count: userKeys.length,
          keys: userKeys,
        };
      } catch (error) {
        elizaLogger.debug("[SecretsInfo] Could not fetch user secrets:", error);
      }

      // Build summary text
      const summaryParts: string[] = [];

      if (results.global) {
        summaryParts.push(`${results.global.count} global secrets`);
      }
      if (results.world) {
        summaryParts.push(`${results.world.count} world-level secrets`);
      }
      if (results.user) {
        summaryParts.push(`${results.user.count} personal secrets`);
      }

      const summaryText =
        summaryParts.length > 0
          ? `Available secrets: ${summaryParts.join(", ")}`
          : "No secrets available";

      return {
        text: summaryText,
        values: {
          hasGlobalSecrets: (results.global?.count || 0) > 0,
          hasWorldSecrets: (results.world?.count || 0) > 0,
          hasUserSecrets: (results.user?.count || 0) > 0,
          globalSecretCount: results.global?.count || 0,
          worldSecretCount: results.world?.count || 0,
          userSecretCount: results.user?.count || 0,
          globalSecretKeys: results.global?.keys || [],
          worldSecretKeys: results.world?.keys || [],
          userSecretKeys: results.user?.keys || [],
        },
        data: results,
      };
    } catch (error) {
      elizaLogger.error("[SecretsInfo] Error fetching secrets info:", error);
      return {
        text: "Error retrieving secrets information",
        values: {},
        error: error.message,
      };
    }
  },
};
