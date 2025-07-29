import type { Content, Memory, Plugin } from "@elizaos/core";
import { createUniqueUuid, EventType, logger } from "@elizaos/core";
import { z } from "zod";
import { modules } from "./actions/modules";
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

const messages = new Map<string, Memory>();

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
    [EventType.RUN_STARTED]: [
      async ({ runtime, runId, entityId, messageId }) => {
        const service = runtime.getService<LevvaService>(
          LevvaService.serviceType
        );

        if (!service) {
          logger.warn("Service not found");
          return;
        }

        const { result, reason } = await service.checkEligibility(
          await runtime.getEntityById(entityId)
        );

        if (!result) {
          logger.warn("Entity is not eligible", { runId, entityId, reason });
          // todo cancelRun(runId, reason)
        }
      },
    ],
  },
  services: [BrowserService, LevvaService],
  actions: modules.map((m) => m.action),
  providers: [levvaProvider, newsProvider],
};

export default plugin;
