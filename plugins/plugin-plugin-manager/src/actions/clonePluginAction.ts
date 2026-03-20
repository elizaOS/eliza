import { Action, type ActionResult, HandlerCallback, IAgentRuntime, Memory, State, logger } from '@elizaos/core';
import * as path from 'node:path';
import { PluginManagerService } from '../services/pluginManagerService';
import { clonePlugin } from '../services/pluginRegistryService';

export const clonePluginAction: Action = {
  name: 'CLONE_PLUGIN',
  similes: ['clone plugin', 'download plugin', 'get plugin source', 'fetch plugin code'],

  description: 'Clone a plugin repository for local development and modification',

  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Clone the weather plugin so I can modify it',
          actions: ['CLONE_PLUGIN'],
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: "I'll clone the weather plugin for you to modify locally.",
          actions: ['CLONE_PLUGIN'],
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Successfully cloned @elizaos/plugin-weather to ./cloned-plugins/plugin-weather\n\nYou can now:\n- Edit the plugin code\n- Run tests with `npm test`\n- Build with `npm run build`\n- Use the plugin-autocoder to make modifications',
          actions: ['CLONE_PLUGIN'],
        },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = message.content?.text?.toLowerCase() || '';
    return text.includes('clone') && text.includes('plugin');
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    logger.info('[clonePluginAction] Starting plugin clone');

    const pluginManager = await runtime.getService('plugin_manager') as PluginManagerService;

    if (!pluginManager) {
      if (callback) {
        await callback({
          text: 'Required services are not available.',
          actions: ['CLONE_PLUGIN'],
        });
      }
      return { success: false, error: 'Required services are not available.' };
    }

    // Extract plugin name from message
    const text = message.content?.text || '';
    const pluginName = extractPluginName(text);

    if (!pluginName) {
      if (callback) {
        await callback({
          text: 'Please specify which plugin you want to clone. For example: "clone the weather plugin" or "clone @elizaos/plugin-weather"',
          actions: ['CLONE_PLUGIN'],
        });
      }
      return { success: false, error: 'Plugin name not specified.' };
    }

    if (callback) {
      await callback({
        text: `Cloning ${pluginName}...`,
        actions: ['CLONE_PLUGIN'],
      });
    }

    // Clone the plugin using API-based registry service
    const result = await clonePlugin(pluginName);

    if (!result.success) {
      if (callback) {
        await callback({
          text: `Failed to clone plugin: ${result.error}`,
          actions: ['CLONE_PLUGIN'],
        });
      }
      return { success: false, error: result.error ?? 'Clone failed.' };
    }

    // Prepare response with helpful information
    let responseText = `Successfully cloned **${result.pluginName}** to \`${result.localPath}\`\n\n`;
    responseText += 'You can now:\n';
    responseText += '- Edit the plugin code in your preferred editor\n';
    responseText += '- Run tests with `npm test` or `pnpm test`\n';
    responseText += '- Build with `npm run build` or `pnpm build`\n';
    responseText += '- Use the plugin-autocoder to make AI-assisted modifications\n';

    if (result.hasTests) {
      responseText +=
        '\n**Note:** This plugin has existing tests. Run them to ensure everything works before making changes.';
    }

    if (result.dependencies && Object.keys(result.dependencies).length > 0) {
      responseText += '\n\n**Dependencies to install:**\n';
      responseText += '';
    }

    if (callback) {
      await callback({
        text: responseText,
        actions: ['CLONE_PLUGIN'],
      });
    }

    return { success: true, data: result };
  },
};

function extractPluginName(text: string): string | null {
  // Try to extract @elizaos/plugin-name format
  const scopedMatch = text.match(/@elizaos\/plugin-[\w-]+/);
  if (scopedMatch) return scopedMatch[0];

  // Try to extract plugin-name format
  const pluginMatch = text.match(/plugin-([\w-]+)/);
  if (pluginMatch) return `@elizaos/plugin-${pluginMatch[1]}`;

  // Try to extract just the name (e.g., "weather plugin" -> "weather")
  const nameMatch = text.match(/(?:clone|download|get|fetch)\s+(?:the\s+)?([\w-]+)\s+plugin/i);
  if (nameMatch) return `@elizaos/plugin-${nameMatch[1]}`;

  return null;
}