import type {
  Action,
  ActionExample,
  IAgentRuntime,
  Memory,
  HandlerCallback,
  State,
} from '@elizaos/core';

/**
 * Action representing the IGNORE action. This action is used when ignoring the user in a conversation.
 *
 * @type {Action}
 * @property {string} name - The name of the action, which is "IGNORE".
 * @property {string[]} similes - An array of related similes for the action.
 * @property {Function} validate - Asynchronous function that validates the action.
 * @property {string} description - Description of when to use the IGNORE action in a conversation.
 * @property {Function} handler - Asynchronous function that handles the action logic.
 * @property {ActionExample[][]} examples - Array of examples demonstrating the usage of the IGNORE action.
 */
/**
 * Represents an action called 'IGNORE'.
 *
 * This action is used to ignore the user in a conversation. It should be used when the user is aggressive, creepy, or when the conversation has naturally ended.
 * Avoid using this action if the user has engaged directly or if there is a need to communicate with them. Use IGNORE only when the user should be ignored.
 *
 * The action includes a validation function that always returns true and a handler function that also returns true.
 *
 * Examples of using the IGNORE action are provided in the 'examples' array. Each example includes messages between two parties and the use of the IGNORE action.
 *
 * @typedef {Action} ignoreAction
 */
export const ignoreAction: Action = {
  name: 'IGNORE',
  similes: ['STOP_TALKING', 'STOP_CHATTING', 'STOP_CONVERSATION'],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => {
    return true;
  },
  description:
    'Call this action if ignoring the user. If the user is aggressive, creepy or is finished with the conversation, use this action. Or, if both you and the user have already said goodbye, use this action instead of saying bye again. Use IGNORE any time the conversation has naturally ended. Do not use IGNORE if the user has engaged directly, or if something went wrong an you need to tell them. Only ignore if the user should be ignored.',
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback,
    responses?: Memory[]
  ) => {
    // If a callback and the agent's response content are available, call the callback
    if (callback && responses?.[0]?.content) {
      // Pass the agent's original response content (thought, IGNORE action, etc.)
      await callback(responses[0].content);
    }
    // Still return true to indicate the action handler succeeded
    return true;
  },
  examples: [
    [
      {
        name: '{{name1}}',
        content: { text: 'Go screw yourself' },
      },
      {
        name: '{{name2}}',
        content: { text: '', actions: ['IGNORE'] },
      },
    ],

    [
      {
        name: '{{name1}}',
        content: { text: 'Shut up, bot' },
      },
      {
        name: '{{name2}}',
        content: { text: '', actions: ['IGNORE'] },
      },
    ],

    [
      {
        name: '{{name1}}',
        content: { text: 'Got any investment advice' },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Uh, don’t let the volatility sway your long-term strategy',
        },
      },
      {
        name: '{{name1}}',
        content: { text: 'Wise words I think' },
      },
      {
        name: '{{name1}}',
        content: { text: 'I gotta run, talk to you later' },
      },
      {
        name: '{{name2}}',
        content: { text: 'See ya' },
      },
      { name: '{{name1}}', content: { text: '' }, actions: ['IGNORE'] },
    ],

    [
      {
        name: '{{name1}}',
        content: { text: 'Gotta go' },
      },
      {
        name: '{{name2}}',
        content: { text: 'Okay, talk to you later' },
      },
      {
        name: '{{name1}}',
        content: { text: 'Cya' },
      },
      {
        name: '{{name2}}',
        content: { text: '', actions: ['IGNORE'] },
      },
    ],

    [
      {
        name: '{{name1}}',
        content: { text: 'bye' },
      },
      {
        name: '{{name2}}',
        content: { text: 'cya' },
      },
      {
        name: '{{name1}}',
        content: { text: '', actions: ['IGNORE'] },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Who added this stupid bot to the chat',
        },
      },
      {
        name: '{{name2}}',
        content: { text: 'Sorry, am I being annoying' },
      },
      {
        name: '{{name1}}',
        content: { text: 'Yeah' },
      },
      {
        name: '{{name1}}',
        content: { text: 'PLEASE shut up' },
      },
      { name: '{{name2}}', content: { text: '', actions: ['IGNORE'] } },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'ur so dumb',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '',
          actions: ['IGNORE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'later nerd',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'bye',
        },
      },
      {
        name: '{{name1}}',
        content: {
          text: '',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '',
          actions: ['IGNORE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'wanna cyber',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'thats inappropriate',
          actions: ['IGNORE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Im out ttyl',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'cya',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '',
          actions: ['IGNORE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'u there',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'yes how can I help',
        },
      },
      {
        name: '{{name1}}',
        content: {
          text: 'k nvm figured it out',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '',
          actions: ['IGNORE'],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;
