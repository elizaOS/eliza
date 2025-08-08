import {
  type Action,
  type ActionExample,
  composePromptFromState,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type State,
  type ActionResult,
  logger,
  parseKeyValueXml,
} from '@elizaos/core';

/**
 * Template for generating dialog and actions for a character.
 *
 * @type {string}
 */
/**
 * Template for generating dialog and actions for a character.
 *
 * @type {string}
 */
const replyTemplate = `# Task: Generate dialog for the character {{agentName}}.

{{providers}}

# Instructions: Write the next message for {{agentName}}.
"thought" should be a short description of what the agent is thinking about and planning.
"message" should be the next message for {{agentName}} which they will send to the conversation.

IMPORTANT CODE BLOCK FORMATTING RULES:
- If {{agentName}} includes code examples, snippets, or multi-line code in the response, ALWAYS wrap the code with \`\`\` fenced code blocks (specify the language if known, e.g., \`\`\`python).
- ONLY use fenced code blocks for actual code. Do NOT wrap non-code text, instructions, or single words in fenced code blocks.
- If including inline code (short single words or function names), use single backticks (\`) as appropriate.
- This ensures the user sees clearly formatted and copyable code when relevant.

Do NOT include any thinking, reasoning, or <think> sections in your response. 
Go directly to the XML response format without any preamble or explanation.

Respond using XML format like this:
<response>
    <thought>Your thought here</thought>
    <message>Your message here</message>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.`;

/**
 * Represents an action that allows the agent to reply to the current conversation with a generated message.
 *
 * This action can be used as an acknowledgement at the beginning of a chain of actions, or as a final response at the end of a chain of actions.
 *
 * @typedef {Object} replyAction
 * @property {string} name - The name of the action ("REPLY").
 * @property {string[]} similes - An array of similes for the action.
 * @property {string} description - A description of the action and its usage.
 * @property {Function} validate - An asynchronous function for validating the action runtime.
 * @property {Function} handler - An asynchronous function for handling the action logic.
 * @property {ActionExample[][]} examples - An array of example scenarios for the action.
 */
export const replyAction = {
  name: 'REPLY',
  similes: ['GREET', 'REPLY_TO_MESSAGE', 'SEND_REPLY', 'RESPOND', 'RESPONSE'],
  description:
    'Replies to the current conversation with the text from the generated message. Default if the agent is responding with a message and no other action. Use REPLY at the beginning of a chain of actions as an acknowledgement, and at the end of a chain of actions as a final response.',
  validate: async (_runtime: IAgentRuntime) => {
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: any,
    callback: HandlerCallback,
    responses?: Memory[]
  ): Promise<ActionResult> => {
    // Access previous action results from context if available
    const context = _options?.context;
    const previousResults = context?.previousResults || [];

    if (previousResults.length > 0) {
      logger.debug(`[REPLY] Found ${previousResults.length} previous action results`);
    }

    // Check if any responses had providers associated with them
    const allProviders = responses?.flatMap((res) => res.content?.providers ?? []) ?? [];

    // Only generate response using LLM if no suitable response was found
    state = await runtime.composeState(message, [
      ...(allProviders ?? []),
      'RECENT_MESSAGES',
      'ACTION_STATE',
    ]);

    const prompt = composePromptFromState({
      state,
      template: runtime.character.templates?.replyTemplate || replyTemplate,
    });

    try {
      const response = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
      });

      // Parse XML response
      const parsedXml = parseKeyValueXml(response);

      const responseContent = {
        thought: parsedXml?.thought || '',
        text: parsedXml?.message || '',
        actions: ['REPLY'],
      };

      await callback(responseContent);

      return {
        text: `Generated reply: ${responseContent.text}`,
        values: {
          success: true,
          responded: true,
          lastReply: responseContent.text,
          lastReplyTime: Date.now(),
          thoughtProcess: parsedXml?.thought,
        },
        data: {
          actionName: 'REPLY',
          response: responseContent,
          thought: parsedXml?.thought,
          messageGenerated: true,
        },
        success: true,
      };
    } catch (error) {
      logger.error(`[REPLY] Error generating response: ${error}`);

      return {
        text: 'Error generating reply',
        values: {
          success: false,
          responded: false,
          error: true,
        },
        data: {
          actionName: 'REPLY',
          error: error instanceof Error ? error.message : String(error),
        },
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  },
  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Hello there!',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Hi! How can I help you today?',
          actions: ['REPLY'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: "What's your favorite color?",
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'I really like deep shades of blue. They remind me of the ocean and the night sky.',
          actions: ['REPLY'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Can you explain how neural networks work?',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Let me break that down for you in simple terms...',
          actions: ['REPLY'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Could you help me solve this math problem?',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "Of course! Let's work through it step by step.",
          actions: ['REPLY'],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;
