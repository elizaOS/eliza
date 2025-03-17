import fs from 'node:fs';
import {
  type Action,
  type ActionExample,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Media,
  type Memory,
  ModelType,
  type State,
  composePromptFromState,
  getEntityDetails,
  parseJSONObjectFromText,
  splitChunks,
  trimTokens,
} from '@elizaos/core';
export const summarizationTemplate = `# Summarized so far (we are adding to this)
{{currentSummary}}

# Current conversation chunk we are summarizing (includes attachments)
{{memoriesWithAttachments}}

Summarization objective: {{objective}}

# Instructions: Summarize the conversation so far. Return the summary. Do not acknowledge this request, just summarize and continue the existing summary if there is one. Capture any important details to the objective. Only respond with the new summary text.
Your response should be extremely detailed and include any and all relevant information.`;

/**
 * Template for providing instructions and details on how to summarize conversation messages and determine the range of dates requested.
 * The template includes placeholders for recent messages, sender name, objective, start and end date range.
 * The response is expected to be formatted as a JSON block with specific structure.
 * @type {string}
 */
export const dateRangeTemplate = `# Messages we are summarizing (the conversation is continued after this)
{{recentMessages}}

# Instructions: {{senderName}} is requesting a summary of the conversation. Your goal is to determine their objective, along with the range of dates that their request covers.
The "objective" is a detailed description of what the user wants to summarize based on the conversation. If they just ask for a general summary, you can either base it off the conversation if the summary range is very recent, or set the object to be general, like "a detailed summary of the conversation between all users".
The "start" and "end" are the range of dates that the user wants to summarize, relative to the current time. The start and end should be relative to the current time, and measured in seconds, minutes, hours and days. The format is "2 days ago" or "3 hours ago" or "4 minutes ago" or "5 seconds ago", i.e. "<integer> <unit> ago".
If you aren't sure, you can use a default range of "0 minutes ago" to "2 hours ago" or more. Better to err on the side of including too much than too little.

Your response must be formatted as a JSON block with this structure:
\`\`\`json
{
  "objective": "<What the user wants to summarize>",
  "start": "0 minutes ago",
  "end": "2 hours ago"
}
\`\`\`
`;

/**
 * Function to get a date range from user input.
 *
 * @param {IAgentRuntime} runtime - The Agent Runtime object.
 * @param {Memory} _message - The Memory object.
 * @param {State} state - The State object.
 * @return {Promise<{ objective: string; start: string | number; end: string | number; } | null>} Parsed user input containing objective, start, and end timestamps, or null.
 */
const getDateRange = async (runtime: IAgentRuntime, _message: Memory, state: State) => {
  const prompt = composePromptFromState({
    state,
    template: dateRangeTemplate,
  });

  for (let i = 0; i < 5; i++) {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });

    // try parsing to a json object
    const parsedResponse = parseJSONObjectFromText(response) as {
      objective: string;
      start: string | number;
      end: string | number;
    } | null;
    // see if it contains objective, start and end
    if (parsedResponse) {
      if (parsedResponse.objective && parsedResponse.start && parsedResponse.end) {
        // TODO: parse start and end into timestamps
        const startIntegerString = (parsedResponse.start as string).match(/\d+/)?.[0];
        const endIntegerString = (parsedResponse.end as string).match(/\d+/)?.[0];

        // parse multiplier
        const multipliers = {
          second: 1 * 1000,
          minute: 60 * 1000,
          hour: 3600 * 1000,
          day: 86400 * 1000,
        };

        const startMultiplier = (parsedResponse.start as string).match(
          /second|minute|hour|day/
        )?.[0];
        const endMultiplier = (parsedResponse.end as string).match(/second|minute|hour|day/)?.[0];

        const startInteger = startIntegerString ? Number.parseInt(startIntegerString) : 0;
        const endInteger = endIntegerString ? Number.parseInt(endIntegerString) : 0;

        // multiply by multiplier
        const startTime = startInteger * multipliers[startMultiplier as keyof typeof multipliers];

        const endTime = endInteger * multipliers[endMultiplier as keyof typeof multipliers];

        // get the current time and subtract the start and end times
        parsedResponse.start = Date.now() - startTime;
        parsedResponse.end = Date.now() - endTime;

        return parsedResponse;
      }
    }
  }
};

/**
 * Action to summarize a conversation and attachments.
 *
 * @typedef {Action} summarizeAction
 * @property {string} name - The name of the action.
 * @property {string[]} similes - Array of related terms.
 * @property {string} description - Description of the action.
 * @property {Function} validate - Asynchronous function to validate the action.
 * @property {Function} handler - Asynchronous function to handle the action.
 * @property {ActionExample[][]} examples - Array of examples demonstrating the action.
 */
export const summarize: Action = {
  name: 'SUMMARIZE_CONVERSATION',
  similes: [
    'RECAP',
    'RECAP_CONVERSATION',
    'SUMMARIZE_CHAT',
    'SUMMARIZATION',
    'CHAT_SUMMARY',
    'CONVERSATION_SUMMARY',
  ],
  description: 'Summarizes the conversation and attachments.',
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    if (message.content.source !== 'discord') {
      return false;
    }
    // only show if one of the keywords are in the message
    const keywords: string[] = [
      'summarize',
      'summarization',
      'summary',
      'recap',
      'report',
      'overview',
      'review',
      'rundown',
      'wrap-up',
      'brief',
      'debrief',
      'abstract',
      'synopsis',
      'outline',
      'digest',
      'abridgment',
      'condensation',
      'encapsulation',
      'essence',
      'gist',
      'main points',
      'key points',
      'key takeaways',
      'bulletpoint',
      'highlights',
      'tldr',
      'tl;dr',
      'in a nutshell',
      'bottom line',
      'long story short',
      'sum up',
      'sum it up',
      'short version',
      'bring me up to speed',
      'catch me up',
    ];
    return keywords.some((keyword) =>
      message.content.text?.toLowerCase().includes(keyword.toLowerCase())
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: any,
    callback: HandlerCallback
  ) => {
    const callbackData: Content = {
      text: '', // fill in later
      actions: ['SUMMARIZATION_RESPONSE'],
      source: message.content.source,
      attachments: [],
    };
    const { roomId } = message;

    // 1. extract date range from the message
    const dateRange = await getDateRange(runtime, message, state);
    if (!dateRange) {
      console.error("Couldn't get date range from message");
      await runtime.createMemory(
        {
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            source: 'discord',
            thought: `I couldn't get the date range from the message`,
            actions: ['SUMMARIZE_CONVERSATION_FAILED'],
          },
          metadata: {
            type: 'SUMMARIZE_CONVERSATION',
          },
        },
        'messages'
      );
      return;
    }

    const { objective, start, end } = dateRange;

    // 2. get these memories from the database
    const memories = await runtime.getMemories({
      tableName: 'messages',
      roomId,
      // subtract start from current time
      start: Number.parseInt(start as string),
      end: Number.parseInt(end as string),
      count: 10000,
      unique: false,
    });

    const entities = await getEntityDetails({
      runtime: runtime as IAgentRuntime,
      roomId,
    });

    const actorMap = new Map(entities.map((entity) => [entity.id, entity]));

    const formattedMemories = memories
      .map((memory) => {
        const attachments = memory.content.attachments
          ?.map((attachment: Media) => {
            return `---\nAttachment: ${attachment.id}\n${attachment.description}\n${attachment.text}\n---`;
          })
          .join('\n');
        return `${actorMap.get(memory.entityId)?.name ?? 'Unknown User'} (${actorMap.get(memory.entityId)?.username ?? ''}): ${memory.content.text}\n${attachments}`;
      })
      .join('\n');

    let currentSummary = '';

    const chunkSize = 8000;

    const chunks = await splitChunks(formattedMemories, chunkSize, 0);

    const _datestr = new Date().toUTCString().replace(/:/g, '-');

    state.values.memoriesWithAttachments = formattedMemories;
    state.values.objective = objective;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      state.values.currentSummary = currentSummary;
      state.values.currentChunk = chunk;
      const template = await trimTokens(summarizationTemplate, chunkSize + 500, runtime);
      const prompt = composePromptFromState({
        state,
        // make sure it fits, we can pad the tokens a bit
        template,
      });

      const summary = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      currentSummary = `${currentSummary}\n${summary}`;
    }

    if (!currentSummary) {
      console.error("No summary found, that's not good!");
      await runtime.createMemory(
        {
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            source: 'discord',
            thought: `I couldn't summarize the conversation`,
            actions: ['SUMMARIZE_CONVERSATION_FAILED'],
          },
          metadata: {
            type: 'SUMMARIZE_CONVERSATION',
          },
        },
        'messages'
      );
      return;
    }

    callbackData.text = currentSummary.trim();
    if (
      callbackData.text &&
      (currentSummary.trim()?.split('\n').length < 4 ||
        currentSummary.trim()?.split(' ').length < 100)
    ) {
      callbackData.text = `Here is the summary:
\`\`\`md
${currentSummary.trim()}
\`\`\`
`;
      await callback(callbackData);
    } else if (currentSummary.trim()) {
      const summaryDir = 'cache';
      const summaryFilename = `${summaryDir}/conversation_summary_${Date.now()}`;
      await runtime.setCache<string>(summaryFilename, currentSummary);
      await fs.promises.mkdir(summaryDir, { recursive: true });

      await fs.promises.writeFile(summaryFilename, currentSummary, 'utf8');
      // save the summary to a file
      await callback(
        {
          ...callbackData,
          text: `I've attached the summary of the conversation from \`${new Date(Number.parseInt(start as string)).toString()}\` to \`${new Date(Number.parseInt(end as string)).toString()}\` as a text file.`,
        },
        [summaryFilename]
      );
    } else {
      console.warn('Empty response from summarize conversation action, skipping');
    }

    return callbackData;
  },
  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: '```js\nconst x = 10\n```',
        },
      },
      {
        name: '{{name1}}',
        content: {
          text: "can you give me a detailed report on what we're talking about?",
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'sure, no problem, give me a minute to get that together for you',
          actions: ['SUMMARIZE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: "please summarize the conversation we just had and include this blogpost i'm linking (Attachment: b3e12)",
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'sure, give me a sec',
          actions: ['SUMMARIZE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Can you summarize what moon and avf are talking about?',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Yeah, just hold on a second while I get that together for you...',
          actions: ['SUMMARIZE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'i need to write a blog post about farming, can you summarize the discussion from a few hours ago?',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'no problem, give me a few minutes to read through everything',
          actions: ['SUMMARIZE'],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;

export default summarize;
