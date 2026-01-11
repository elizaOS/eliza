/**
 * N8n AutoPlugin for elizaOS
 *
 * Provides AI-powered plugin creation capabilities using Claude models.
 * Enables agents to autonomously create, build, test, and deploy ElizaOS plugins.
 *
 * ## Features
 *
 * - AI-powered plugin code generation
 * - Iterative refinement with build/lint/test validation
 * - Natural language to plugin specification conversion
 * - Plugin registry tracking
 *
 * ## Configuration
 *
 * Required:
 * - ANTHROPIC_API_KEY: Your Anthropic API key
 *
 * Optional:
 * - PLUGIN_DATA_DIR: Directory for plugin workspace (default: ./data)
 * - CLAUDE_MODEL: Model to use (default: claude-3-opus-20240229)
 */

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

// Re-export types for consumers
export * from "./types";

/**
 * Plugin configuration object structure
 */
export interface PluginConfig {
  readonly ANTHROPIC_API_KEY?: string;
  readonly PLUGIN_DATA_DIR?: string;
  readonly CLAUDE_MODEL?: string;
}

/**
 * N8n AutoPlugin for elizaOS.
 *
 * Provides AI-powered plugin creation using Claude models.
 */
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

// Export individual components for direct use
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

// Default export
export default n8nPlugin;
