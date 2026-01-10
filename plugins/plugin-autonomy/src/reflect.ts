import {
  type Action,
  type ActionExample,
  composePromptFromState,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type State,
  parseKeyValueXml,
  createUniqueUuid,
} from '@elizaos/core';

/**
 * Template for generating dialog and actions for a character.
 *
 * @type {string}
 */
const reflectTemplate = `# Task: Generate a thoughtful reflection for the character {{agentName}}.
{{providers}}
# Instructions: Write the next reflection for {{agentName}}.
"thought" should be a short description of what the agent is thinking about and planning.
"message" should be the resulting message {{agentName}} will articulate based on the thought.

Respond using XML format like this:
<response>
    <thought>
        Agent's thinking goes here
    </thought>
    <message>
        The message {{agentName}} will say.
    </message>
</response>

Your response must ONLY include the <response></response> XML block.`;

/**
 * Represents an action that allows the agent to reflect to the current conversation with a generated message.
 *
 * This action can be used as an acknowledgement at the beginning of a chain of actions, or as a final response at the end of a chain of actions.
 *
 * @typedef {Object} reflectAction
 * @property {string} name - The name of the action ("REFLECT").
 * @property {string[]} similes - An array of similes for the action.
 * @property {string} description - A description of the action and its usage.
 * @property {Function} validate - An asynchronous function for validating the action runtime.
 * @property {Function} handler - An asynchronous function for handling the action logic.
 * @property {ActionExample[][]} examples - An array of example scenarios for the action.
 */
export const reflectAction = {
  name: 'REFLECT',
  similes: ['REFLECTION'],
  description:
    'Take a moment to process the current situation and respond thoughtfully. Use REFLECT both to acknowledge the start of a sequence of actions and to provide a final considered response at the end.',
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
  ) => {
    // Find all responses with REFLECT action and text
    const existingResponses = responses?.filter(
      (response) => response.content.actions?.includes('REFLECT') && response.content.message
    );

    // If we found any existing responses, use them and skip LLM
    if (existingResponses && existingResponses.length > 0) {
      for (const response of existingResponses) {
        const responseContent = {
          thought: response.content.thought || 'Using provided text for reflect',
          text: response.content.message as string,
          actions: ['REFLECT'],
        };
        await callback(responseContent);
      }
      return;
    }

    // Only generate response using LLM if no suitable response was found
    state = await runtime.composeState(message, [
      ...(message.content.providers ?? []),
      'AUTONOMOUS_FEED',
    ]);

    const prompt = composePromptFromState({
      state,
      template: reflectTemplate,
    });

    const xmlResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });

    const parsedXml = parseKeyValueXml(xmlResponse);

    const responseContent = {
      thought: (parsedXml?.thought as string) || 'Reflecting on the situation.',
      text: (parsedXml?.message as string) || '',
      actions: ['REFLECT'],
    };

    const memory: Memory = {
      content: {
        text: responseContent.text,
        thought: responseContent.thought,
        actions: responseContent.actions,
      },
      entityId: createUniqueUuid(runtime, runtime.agentId),
      agentId: runtime.agentId,
      roomId: message.roomId,
      worldId: message.worldId,
    };

    await runtime.createMemory(memory, 'messages');

    await callback(memory.content);
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
          text: 'Hmm, a greeting. I should probably reciprocate.',
          actions: ['REFLECT'],
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
          text: "That's an interesting question. I recall processing data about human color preferences. Blue is often favored.",
          actions: ['REFLECT'],
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
          text: "Neural networks... a complex topic. I should try to simplify it. It's about layers of interconnected nodes, like digital neurons.",
          actions: ['REFLECT'],
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
          text: 'A math problem. I need to understand the components and operations involved before attempting a solution.',
          actions: ['REFLECT'],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;
