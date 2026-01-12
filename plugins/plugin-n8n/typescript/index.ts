import type { Plugin } from "@elizaos/core";
import {
  cancelPluginCreationAction,
  checkPluginCreationStatusAction,
  createPluginAction,
  createPluginFromDescriptionAction,
} from "./actions/plugin-creation-actions";
import {
  pluginCreationCapabilitiesProvider,
  pluginCreationStatusProvider,
  pluginExistsProvider,
  pluginRegistryProvider,
} from "./providers";
import { PluginCreationService } from "./services/plugin-creation-service";

/**
 * Plugin configuration object structure
 */
export interface PluginConfig {
  readonly ANTHROPIC_API_KEY?: string;
  readonly PLUGIN_DATA_DIR?: string;
  readonly CLAUDE_MODEL?: string;
}

export const n8nPlugin: Plugin = {
  name: "@elizaos/plugin-n8n",
  description: "N8n workflow integration plugin with AI-powered plugin creation for ElizaOS",

  config: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    PLUGIN_DATA_DIR: process.env.PLUGIN_DATA_DIR,
    CLAUDE_MODEL: process.env.CLAUDE_MODEL,
  },

  actions: [
    createPluginAction,
    checkPluginCreationStatusAction,
    cancelPluginCreationAction,
    createPluginFromDescriptionAction,
  ],

  providers: [
    pluginCreationStatusProvider,
    pluginCreationCapabilitiesProvider,
    pluginRegistryProvider,
    pluginExistsProvider,
  ],

  services: [PluginCreationService],
  evaluators: [],
  tests: [],
};

export {
  PluginCreationService,
  createPluginAction,
  checkPluginCreationStatusAction,
  cancelPluginCreationAction,
  createPluginFromDescriptionAction,
  pluginCreationStatusProvider,
  pluginCreationCapabilitiesProvider,
  pluginRegistryProvider,
  pluginExistsProvider,
};

export default n8nPlugin;
