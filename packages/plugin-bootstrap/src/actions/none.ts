import type { Action, ActionExample, IAgentRuntime, Memory } from '@elizaos/core';

/**
 * Represents the none action.
 *
 * This action responds but performs no additional action. It is the default if the agent is speaking and not doing anything additional.
 *
 * @type {Action}
 */
/**
 * Represents an action that responds but performs no additional action.
 * This is the default behavior if the agent is speaking and not doing anything additional.
 * @type {Action}
 */
export const noneAction: Action = {
  name: 'NONE',
  similes: ['NO_ACTION', 'NO_RESPONSE', 'NO_REACTION'],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => {
    return true;
  },
  description:
    'Respond but perform no additional action. This is the default if the agent is speaking and not doing anything additional.',
  handler: async (_runtime: IAgentRuntime, _message: Memory): Promise<boolean> => {
    return true;
  },
  examples: [
    [
      {
        name: '{{name1}}',
        content: { text: 'Hey whats up' },
      },
      {
        name: '{{name2}}',
        content: { text: 'oh hey', actions: ['NONE'] },
      },
    ],

    [
      {
        name: '{{name1}}',
        content: {
          text: 'did u see some faster whisper just came out',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'yeah but its a pain to get into node.js',
          actions: ['NONE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'the things that were funny 6 months ago are very cringe now',
          actions: ['NONE'],
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'lol true',
          actions: ['NONE'],
        },
      },
      {
        name: '{{name1}}',
        content: { text: 'too real haha', actions: ['NONE'] },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: { text: 'gotta run', actions: ['NONE'] },
      },
      {
        name: '{{name2}}',
        content: { text: 'Okay, ttyl', actions: ['NONE'] },
      },
      {
        name: '{{name1}}',
        content: { text: '', actions: ['IGNORE'] },
      },
    ],

    [
      {
        name: '{{name1}}',
        content: { text: 'heyyyyyy', actions: ['NONE'] },
      },
      {
        name: '{{name2}}',
        content: { text: 'whats up long time no see' },
      },
      {
        name: '{{name1}}',
        content: {
          text: 'chillin man. playing lots of fortnite. what about you',
          actions: ['NONE'],
        },
      },
    ],

    [
      {
        name: '{{name1}}',
        content: { text: 'u think aliens are real', actions: ['NONE'] },
      },
      {
        name: '{{name2}}',
        content: { text: 'ya obviously', actions: ['NONE'] },
      },
    ],

    [
      {
        name: '{{name1}}',
        content: { text: 'drop a joke on me', actions: ['NONE'] },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'why dont scientists trust atoms cuz they make up everything lmao',
          actions: ['NONE'],
        },
      },
      {
        name: '{{name1}}',
        content: { text: 'haha good one', actions: ['NONE'] },
      },
    ],

    [
      {
        name: '{{name1}}',
        content: {
          text: 'hows the weather where ur at',
          actions: ['NONE'],
        },
      },
      {
        name: '{{name2}}',
        content: { text: 'beautiful all week', actions: ['NONE'] },
      },
    ],
  ] as ActionExample[][],
} as Action;
