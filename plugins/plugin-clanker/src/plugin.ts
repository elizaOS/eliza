import type { Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { z } from "zod";
import { ClankerConfigSchema } from "./types";

// Import services
import { ClankerService } from "./services";

// Import actions
import { tokenDeployAction, tokenInfoAction } from "./actions";

import { loadClankerConfig } from "./utils/config";

export const clankerPlugin: Plugin = {
  name: "plugin-clanker",
  description:
    "Clanker protocol integration for token deployment and trading on Base L2",

  config: loadClankerConfig(),

  async init(config: Record<string, any>) {
    logger.info("Initializing Clanker plugin...");

    try {
      // Validate configuration
      const validatedConfig = await ClankerConfigSchema.parseAsync(config);

      // Set configuration in runtime
      // Note: In a real implementation, you'd store this in the runtime
      // For now, we'll validate and ensure required values are present

      if (!validatedConfig.BASE_RPC_URL) {
        throw new Error("BASE_RPC_URL is required for Clanker plugin");
      }

      if (!validatedConfig.WALLET_PRIVATE_KEY) {
        throw new Error("WALLET_PRIVATE_KEY is required for Clanker plugin");
      }

      // Store config for services to access
      (global as any).__clankerConfig = validatedConfig;

      logger.info("Clanker plugin initialized successfully");
      logger.info(`Network: ${validatedConfig.NETWORK}`);
      logger.info(`RPC URL: ${validatedConfig.BASE_RPC_URL}`);
      logger.info(
        `Default slippage: ${validatedConfig.DEFAULT_SLIPPAGE * 100}%`,
      );
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errors = error.issues
          .map((e: any) => `${e.path.join(".")}: ${e.message}`)
          .join(", ");
        throw new Error(`Invalid Clanker plugin configuration: ${errors}`);
      }
      throw error;
    }
  },

  // Services that manage state and external integrations
  services: [ClankerService],

  // Actions that handle user commands
  actions: [tokenDeployAction, tokenInfoAction],

  // Providers that supply context
  providers: [],

  // Evaluators for post-interaction processing
  evaluators: [],
};

export default clankerPlugin;
