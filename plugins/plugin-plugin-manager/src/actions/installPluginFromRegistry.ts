import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from '@elizaos/core';
import { PluginManagerService } from '../services/pluginManagerService';

export const installPluginFromRegistryAction: Action = {
  name: 'INSTALL_PLUGIN_FROM_REGISTRY',
  description: 'Install a plugin from the ElizaOS plugin registry',
  similes: [
    'install plugin from registry',
    'add plugin from registry',
    'download plugin',
    'get plugin from registry',
  ],

  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Install plugin @elizaos/plugin-weather from registry',
          actions: ['INSTALL_PLUGIN_FROM_REGISTRY'],
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Installing @elizaos/plugin-weather from the registry now.',
          actions: ['INSTALL_PLUGIN_FROM_REGISTRY'],
        },
      },
    ],
  ],

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<void> {
    const pluginManagerService = runtime.getService('plugin_manager') as PluginManagerService;

    if (!pluginManagerService) {
      if (callback) {
        await callback({
          text: 'Plugin manager service not available',
        });
      }
      return;
    }

    // Extract plugin name from message content
    const content = message.content?.text?.toLowerCase() || '';
    let pluginNameMatch: RegExpMatchArray | null = null;
    let pluginName: string | null = null;

    // Try different patterns to extract plugin name
    // Pattern 1: install [plugin] from registry <name>
    pluginNameMatch = content.match(/install\s+(?:plugin\s+)?from\s+registry\s+([^\s]+)/i);
    if (pluginNameMatch) {
      pluginName = pluginNameMatch[1];
    }

    // Pattern 2: install [plugin] <name> [from registry]
    if (!pluginName) {
      pluginNameMatch = content.match(/install\s+(?:plugin\s+)?([^\s]+?)(?:\s+from\s+registry)?$/i);
      if (pluginNameMatch && pluginNameMatch[1] !== 'from') {
        pluginName = pluginNameMatch[1];
      }
    }

    // Pattern 3: add/download/get plugin <name>
    if (!pluginName) {
      pluginNameMatch = content.match(/(?:add|download|get)\s+(?:plugin\s+)?([^\s]+)/i);
      if (pluginNameMatch) {
        pluginName = pluginNameMatch[1];
      }
    }

    if (!pluginName) {
      if (callback) {
        await callback({
          text: 'Please specify a plugin name to install. Example: "install plugin @elizaos/plugin-example"',
        });
      }
      return;
    }

    try {
      const pluginInfo = await pluginManagerService.installPluginFromRegistry(pluginName);

      if (pluginInfo.status === 'needs_configuration') {
        if (callback) {
          await callback({
            text:
              `Plugin ${pluginInfo.name} has been installed but requires configuration:\n` +
              pluginInfo.requiredEnvVars
                .map((v) => `- ${v.name}: ${v.description}${v.sensitive ? ' (sensitive)' : ''}`)
                .join('\n') +
              '\n\nUse "configure plugin" to set up the required environment variables.',
          });
        }
        return;
      }

      if (callback) {
        await callback({
          text:
            `Successfully installed plugin ${pluginInfo.name} v${pluginInfo.version}. ` +
            `Use "load plugin ${pluginName}" to activate it.`,
        });
      }
    } catch (error) {
      if (callback) {
        await callback({
          text: `Failed to install plugin ${pluginName}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
      }
    }
  },

  async validate(runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> {
    const text = message.content?.text?.toLowerCase() || '';

    // Check for install/registry-related keywords
    const hasInstall = text.includes('install');
    const hasRegistry = text.includes('registry') || text.includes('npm');
    const hasPlugin = text.includes('plugin');

    // Look for plugin name patterns
    let match: RegExpMatchArray | null = null;
    match = text.match(/@[\w-]+\/[\w-]+/); // @scope/package format

    if (!match) {
      match = text.match(/plugin-[\w-]+/); // plugin-name format
    }

    if (!match) {
      // Look for "install [name] plugin" pattern
      match = text.match(/install\s+([\w-]+)\s+plugin/);
    }

    const hasPluginName = match !== null;

    // Valid if it's an install command with plugin context
    return (hasInstall && (hasRegistry || hasPlugin)) || hasPluginName;
  },
};
