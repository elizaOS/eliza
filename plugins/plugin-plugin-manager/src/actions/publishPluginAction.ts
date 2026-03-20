import { Action, type ActionResult, HandlerCallback, IAgentRuntime, Memory, State, logger } from '@elizaos/core';

export const publishPluginAction: Action = {
  name: 'PUBLISH_PLUGIN',
  similes: ['publish plugin', 'release plugin', 'deploy plugin', 'push plugin to registry'],

  description:
    'Publish a plugin to npm registry or create a pull request to add it to the Eliza plugin registry',

  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Publish my weather plugin to npm',
          actions: ['PUBLISH_PLUGIN'],
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: "I'll help you publish your weather plugin to npm.",
          actions: ['PUBLISH_PLUGIN'],
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Successfully published @elizaos/plugin-weather to npm!\n\nVersion: 1.0.0\nRegistry: https://www.npmjs.com/package/@elizaos/plugin-weather\n\nNext steps:\n- Create a PR to add it to the official Eliza plugin registry\n- Update the README with installation instructions',
          actions: ['PUBLISH_PLUGIN'],
        },
      },
    ],
  ],

  async validate(runtime: IAgentRuntime, message: Memory): Promise<boolean> {
    const text = message.content?.text?.toLowerCase() || '';
    return text.includes('publish') && text.includes('plugin');
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    logger.info('[publishPluginAction] Starting plugin publication');

    // Temporarily disabled while migrating to new registry system
    const text =
      '⚠️ Plugin publishing is temporarily unavailable while we migrate to the new registry system.\n\nYou can still publish manually using:\n';

    if (callback) {
      callback({ text, content: { success: false, error: 'Feature temporarily disabled' } });
    }

    return {
      success: false,
      error: 'Feature temporarily disabled',
    };
  },
};