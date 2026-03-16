import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  cancelPluginCreationAction,
  checkPluginCreationStatusAction,
  createPluginAction,
  createPluginFromDescriptionAction,
} from "./actions/plugin-creation-actions";
import { pluginCreationStatusProvider, pluginRegistryProvider } from "./providers";
import { PluginCreationService } from "./services/plugin-creation-service";
import {
  activateWorkflowAction,
  createWorkflowAction,
  deactivateWorkflowAction,
  deleteWorkflowAction,
  getExecutionsAction,
} from "./workflow/actions/index";
import * as dbSchema from "./workflow/db/index";
import { n8nWorkflowsProvider } from "./workflow/providers/index";
import { N8nCredentialStore, N8nWorkflowService } from "./workflow/services/index";

/**
 * Plugin configuration object structure
 */
export interface PluginConfig {
  readonly ANTHROPIC_API_KEY?: string;
  readonly PLUGIN_DATA_DIR?: string;
  readonly CLAUDE_MODEL?: string;
  readonly N8N_API_KEY?: string;
  readonly N8N_HOST?: string;
}

export const n8nPlugin: Plugin = {
  name: "@elizaos/plugin-n8n",
  description:
    "N8n integration plugin for elizaOS: create elizaOS plugins with AI and " +
    "generate/manage n8n workflows from natural language.",

  config: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    PLUGIN_DATA_DIR: process.env.PLUGIN_DATA_DIR,
    CLAUDE_MODEL: process.env.CLAUDE_MODEL,
    N8N_API_KEY: process.env.N8N_API_KEY,
    N8N_HOST: process.env.N8N_HOST,
  },

  actions: [
    // Plugin creation actions
    createPluginAction,
    checkPluginCreationStatusAction,
    cancelPluginCreationAction,
    createPluginFromDescriptionAction,
    // Workflow management actions
    createWorkflowAction,
    getExecutionsAction,
    activateWorkflowAction,
    deactivateWorkflowAction,
    deleteWorkflowAction,
  ],

  providers: [
    // Plugin creation providers
    pluginCreationStatusProvider,
    pluginRegistryProvider,
    // Workflow provider (unified)
    n8nWorkflowsProvider,
  ],

  services: [PluginCreationService, N8nWorkflowService, N8nCredentialStore],

  schema: dbSchema,

  init: async (_config: Record<string, string>, runtime: IAgentRuntime): Promise<void> => {
    const apiKey = runtime.getSetting("N8N_API_KEY");
    const host = runtime.getSetting("N8N_HOST");

    logger.info(
      { src: "plugin:n8n:init" },
      `n8n Plugin - API Key: ${apiKey ? "configured" : "not configured"}, Host: ${host || "not set"}`
    );

    if (!apiKey) {
      logger.warn(
        { src: "plugin:n8n:init" },
        "N8N_API_KEY not provided — workflow features will not be functional."
      );
    }

    if (!host) {
      logger.warn(
        { src: "plugin:n8n:init" },
        "N8N_HOST not provided — workflow features will not be functional."
      );
    }

    // Check for pre-configured credentials (optional)
    const workflowSettings = runtime.character?.settings?.workflows as
      | { credentials?: Record<string, string> }
      | undefined;
    if (workflowSettings?.credentials) {
      const credCount = Object.keys(workflowSettings.credentials).filter(
        (k) => workflowSettings.credentials?.[k]
      ).length;
      logger.info(
        { src: "plugin:n8n:init" },
        `Pre-configured credentials: ${credCount} credential types`
      );
    }

    logger.info({ src: "plugin:n8n:init" }, "n8n Plugin initialized successfully");
  },

  evaluators: [],
  tests: [],
};

// Plugin creation exports
export {
  PluginCreationService,
  createPluginAction,
  checkPluginCreationStatusAction,
  cancelPluginCreationAction,
  createPluginFromDescriptionAction,
  pluginCreationStatusProvider,
  pluginRegistryProvider,
};

// Workflow management exports
export {
  N8nWorkflowService,
  N8nCredentialStore,
  createWorkflowAction,
  getExecutionsAction,
  activateWorkflowAction,
  deactivateWorkflowAction,
  deleteWorkflowAction,
  n8nWorkflowsProvider,
};

export default n8nPlugin;
