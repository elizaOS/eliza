import type { Plugin } from "@elizaos/core";
import { EventType, logger } from "@elizaos/core";
import { z } from "zod";
import { swapTokens } from "./actions/swap";
import { analyzeWallet } from "./actions/wallet";
import { levvaProvider } from "./providers";
import calldataRoute from "./routes/calldata";
import levvaUserRoute from "./routes/levva-user";
import suggestRoute from "./routes/suggest";
import { BrowserService } from "./services/browser";
import { LevvaService } from "./services/levva/class";
import { newsProvider } from "./providers/news";

/**
 * Define the configuration schema for the plugin with the following properties:
 *
 * @param {string} KYBER_CLIENT_ID - Kyberswap client id
 * @returns {object} - The configured schema object
 */
const configSchema = z.object({
  KYBER_CLIENT_ID: z
    .string()
    .min(1, "Kyberswap client id is not provided")
    .optional()
    .transform((val) => {
      if (!val) {
        console.warn("Warning: Kyberswap client id is not provided");
      }

      return val;
    }),
});

const plugin: Plugin = {
  name: "levva",
  description: "Levva plugin for Eliza",
  priority: -1,
  dependencies: ["bootstrap"], // ensure that bootstrap is loaded first
  config: {
    KYBER_CLIENT_ID: process.env.KYBER_CLIENT_ID,
  },
  async init(config: Record<string, string>) {
    logger.info("*** Initializing levva plugin ***");
    try {
      const validatedConfig = await configSchema.parseAsync(config);

      // Set all environment variables at once
      for (const [key, value] of Object.entries(validatedConfig)) {
        if (value) process.env[key] = value;
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(
          `Invalid plugin configuration: ${error.errors.map((e) => e.message).join(", ")}`
        );
      }
      throw error;
    }
  },
  routes: [calldataRoute, levvaUserRoute, suggestRoute],
  events: {
    [EventType.MESSAGE_RECEIVED]: [
      async ({ runtime, message, callback }) => {
        logger.info("MESSAGE_RECEIVED event received");
      },
    ],
    [EventType.ROOM_JOINED]: [
      async (params) => {
        logger.info("ROOM_JOINED event received");
        // console.log({ params });
      },
    ],
    [EventType.ENTITY_JOINED]: [
      async (params) => {
        logger.info("ENTITY_JOINED event received");
        // console.log({ params });
      },
    ],
    VOICE_MESSAGE_RECEIVED: [
      async (params) => {
        logger.info("VOICE_MESSAGE_RECEIVED event received");
        // print the keys
        logger.info(Object.keys(params));
      },
    ],
    WORLD_CONNECTED: [
      async (params) => {
        logger.info("WORLD_CONNECTED event received");
        // print the keys
        logger.info(Object.keys(params));
      },
    ],
    WORLD_JOINED: [
      async (params) => {
        logger.info("WORLD_JOINED event received");
        // print the keys
        logger.info(Object.keys(params));
      },
    ],
  },
  services: [BrowserService, LevvaService],
  actions: [swapTokens, analyzeWallet],
  providers: [levvaProvider, newsProvider],
};

export default plugin;
