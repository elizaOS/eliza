import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { z } from "zod";
import "./service-registry.js";
import { computeruseClickAction } from "./actions/click.js";
import { computeruseGetApplicationsAction } from "./actions/get-applications.js";
import { computeruseGetWindowTreeAction } from "./actions/get-window-tree.js";
import { computeruseOpenApplicationAction } from "./actions/open-application.js";
import { computeruseTypeAction } from "./actions/type.js";
import { computeruseAvailableAppsProvider } from "./providers/available-apps.js";
import { computeruseStateProvider } from "./providers/computeruse-state.js";
import { ComputerUseService } from "./services/computeruse-service.js";

export * from "./types.js";
export { ComputerUseService };

const configSchema = z.object({
  COMPUTERUSE_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((val) => val === "true"),
  COMPUTERUSE_MODE: z.enum(["auto", "local", "mcp"]).optional().default("auto"),
  COMPUTERUSE_MCP_SERVER: z.string().optional().default("computeruse"),
});

export const computerusePlugin: Plugin = {
  name: "plugin-computeruse",
  description: "Computer automation plugin (local or MCP)",
  config: {
    COMPUTERUSE_ENABLED: process.env.COMPUTERUSE_ENABLED ?? "false",
    COMPUTERUSE_MODE: process.env.COMPUTERUSE_MODE ?? "auto",
    COMPUTERUSE_MCP_SERVER: process.env.COMPUTERUSE_MCP_SERVER ?? "computeruse",
  },
  async init(config: Record<string, string>, _runtime: IAgentRuntime): Promise<void> {
    logger.info("Initializing computeruse plugin");
    const validated = await configSchema.parseAsync(config);
    for (const [key, value] of Object.entries(validated)) {
      process.env[key] = String(value);
    }
  },
  services: [ComputerUseService],
  actions: [
    computeruseOpenApplicationAction,
    computeruseClickAction,
    computeruseTypeAction,
    computeruseGetApplicationsAction,
    computeruseGetWindowTreeAction,
  ],
  providers: [computeruseStateProvider, computeruseAvailableAppsProvider],
  dependencies: ["mcp"],
};

export default computerusePlugin;
