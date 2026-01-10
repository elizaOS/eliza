import { Plugin } from '@elizaos/core';
import { PluginCreationService } from './services/plugin-creation-service.ts';
import {
  createPluginAction,
  checkPluginCreationStatusAction,
  cancelPluginCreationAction,
  createPluginFromDescriptionAction,
} from './actions/plugin-creation-actions.ts';
import {
  pluginCreationStatusProvider,
  pluginCreationCapabilitiesProvider,
  pluginRegistryProvider,
  pluginExistsProvider,
} from './providers/plugin-creation-providers.ts';
import { pluginCreationE2ETests } from './e2e/plugin-creation.test.ts';
import { pluginActionsE2ETests } from './e2e/plugin-actions.test.ts';

// Export the plugin
export const pluginDynamic: Plugin = {
  name: '@elizaos/plugin-auton8n',
  description: 'N8n workflow integration plugin with AI-powered plugin creation for ElizaOS',
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
  tests: [pluginCreationE2ETests, pluginActionsE2ETests],
};

// Export individual components
export {
  PluginCreationService,
  createPluginAction,
  checkPluginCreationStatusAction,
  cancelPluginCreationAction,
  createPluginFromDescriptionAction,
  pluginCreationStatusProvider,
  pluginCreationCapabilitiesProvider,
};

// Default export
export default pluginDynamic;

// Re-export types and utilities
export {
  type PluginSpecification,
  type PluginCreationJob,
  ClaudeModel,
} from './services/plugin-creation-service.ts';
export * from './utils/plugin-templates.ts';
export { pluginRegistryProvider, pluginExistsProvider };
