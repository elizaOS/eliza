import fs from 'node:fs';
import {
  type Action,
  type ActionExample,
  ChannelType,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type State,
  composePromptFromState,
  parseJSONObjectFromText,
  trimTokens,
} from '@elizaos/core';

export const summarizationTemplate = `# Summarized so far (we are adding to this)
{{currentSummary}}

# Current attachments we are summarizing
{{attachmentsWithText}}

Summarization objective: {{objective}}

# Instructions: Summarize the attachments. Return the summary. Do not acknowledge this request, just summarize and continue the existing summary if there is one. Capture any important details based on the objective. Only respond with the new summary text.`;

/**
 * Template for generating a summary of specific attachments based on recent messages.
 * This template includes placeholders for recentMessages, senderName, objective, and attachmentIds.
 * To generate a response, the user's objective and a list of attachment IDs must be determined.
 *
 * @type {string}
 */
export const attachmentIdsTemplate = `# Messages we are summarizing
{{recentMessages}}

# Instructions: {{senderName}} is requesting a summary of specific attachments. Your goal is to determine their objective, along with the list of attachment IDs to summarize.
The "objective" is a detailed description of what the user wants to summarize based on the conversation.
The "attachmentIds" is an array of attachment IDs that the user wants to summarize. If not specified, default to including all attachments from the conversation.

Your response must be formatted as a JSON block with this structure:
\`\`\`json
{
  "objective": "<What the user wants to summarize>",
  "attachmentIds": ["<Attachment ID 1>", "<Attachment ID 2>", ...]
}
\`\`\`
`;

/**
 * Retrieves attachment IDs from a model using a prompt generated from the current state and a template.
 * @param {IAgentRuntime} runtime - The agent runtime to use for interaction with models
 * @param {Memory} _message - The memory object
 * @param {State} state - The current state of the conversation
 * @returns {Promise<{ objective: string; attachmentIds: string[] } | null>} An object containing the objective and attachment IDs, or null if the data could not be retrieved after multiple attempts
 */
const getAttachmentIds = async (
  runtime: IAgentRuntime,
  _message: Memory,
  state: State
): Promise<{ objective: string; attachmentIds: string[] } | null> => {
  const prompt = composePromptFromState({
    state,
    template: attachmentIdsTemplate,
  });

  for (let i = 0; i < 5; i++) {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });
    // try parsing to a json object
    const parsedResponse = parseJSONObjectFromText(response) as {
      objective: string;
      attachmentIds: string[];
    } | null;
    // see if it contains objective and attachmentIds
    if (parsedResponse?.objective && parsedResponse?.attachmentIds) {
      return parsedResponse;
    }
  }
  return null;
};

/**
 * Represents an action to summarize user request informed by specific attachments based on their IDs.
 * If a user asks to chat with a PDF, or wants more specific information about a link or video or anything else they've attached, this is the action to use.
 * @typedef {Object} summarizeAction
 * @property {string} name - The name of the action
 * @property {string[]} similes - Similar actions related to summarization with attachments
 * @property {string} description - Description of the action
 * @property {Function} validate - Validation function to check if the action should be triggered based on keywords in the message
 * @property {Function} handler - Handler function to process the user request, summarize attachments, and provide a summary
 * @property {Object[]} examples - Examples demonstrating how to use the action with message content and expected responses
 */

export const chatWithAttachments: Action = {
  name: 'CHAT_WITH_ATTACHMENTS',
  similes: [
    'CHAT_WITH_ATTACHMENT',
    'SUMMARIZE_FILES',
    'SUMMARIZE_FILE',
    'SUMMARIZE_ATACHMENT',
    'CHAT_WITH_PDF',
    'ATTACHMENT_SUMMARY',
    'RECAP_ATTACHMENTS',
    'SUMMARIZE_FILE',
    'SUMMARIZE_VIDEO',
    'SUMMARIZE_AUDIO',
    'SUMMARIZE_IMAGE',
    'SUMMARIZE_DOCUMENT',
    'SUMMARIZE_LINK',
    'ATTACHMENT_SUMMARY',
    'FILE_SUMMARY',
  ],
  description:
    "Answer a user request informed by specific attachments based on their IDs. If a user asks to chat with a PDF, or wants more specific information about a link or video or anything else they've attached, this is the action to use.",
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    const room = await _runtime.getRoom(message.roomId);
    if (room?.type !== ChannelType.GROUP) {
      return false;
    }
    // only show if one of the keywords are in the message
    const keywords: string[] = [
      'attachment',
      'summary',
      'summarize',
      'research',
      'pdf',
      'video',
      'audio',
      'image',
      'document',
      'link',
      'file',
      'attachment',
      'summarize',
      'code',
      'report',
      'write',
      'details',
      'information',
      'talk',
      'chat',
      'read',
      'listen',
      'watch',
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
      actions: ['CHAT_WITH_ATTACHMENTS_RESPONSE'],
      source: message.content.source,
      attachments: [],
    };

    // 1. extract attachment IDs from the message
    const attachmentData = await getAttachmentIds(runtime, message, state);
    if (!attachmentData) {
      console.error("Couldn't get attachment IDs from message");
      await runtime.createMemory(
        {
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            source: message.content.source,
            thought: "I tried to chat with attachments but I couldn't get attachment IDs",
            actions: ['CHAT_WITH_ATTACHMENTS_FAILED'],
          },
          metadata: {
            type: 'CHAT_WITH_ATTACHMENTS',
          },
        },
        'messages'
      );
      return;
    }

    const { objective, attachmentIds } = attachmentData;

    const conversationLength = runtime.getConversationLength();

    const recentMessages = await runtime.getMemories({
      tableName: 'messages',
      roomId: message.roomId,
      count: conversationLength,
      unique: false,
    });

    // This is pretty gross but it can catch cases where the returned generated UUID is stupidly wrong for some reason
    const attachments = recentMessages
      .filter((msg) => msg.content.attachments && msg.content.attachments.length > 0)
      .flatMap((msg) => msg.content.attachments)
      // check by first 5 characters of uuid
      .filter(
        (attachment) =>
          attachmentIds
            .map((attch) => attch.toLowerCase().slice(0, 5))
            .includes(attachment.id.toLowerCase().slice(0, 5)) ||
          // or check the other way
          attachmentIds.some((id) => {
            const attachmentId = id.toLowerCase().slice(0, 5);
            return attachment.id.toLowerCase().includes(attachmentId);
          })
      );

    const attachmentsWithText = attachments
      .map((attachment) => `# ${attachment.title}\n${attachment.text}`)
      .join('\n\n');

    let currentSummary = '';

    const chunkSize = 8192;

    state.values.attachmentsWithText = attachmentsWithText;
    state.values.objective = objective;
    const template = await trimTokens(summarizationTemplate, chunkSize, runtime);
    const prompt = composePromptFromState({
      state,
      // make sure it fits, we can pad the tokens a bit
      // Get the model's tokenizer based on the current model being used
      template,
    });

    const summary = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });

    currentSummary = `${currentSummary}\n${summary}`;

    if (!currentSummary) {
      console.error("No summary found, that's not good!");
      await runtime.createMemory(
        {
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            source: message.content.source,
            thought: "I tried to chat with attachments but I couldn't get a summary",
            actions: ['CHAT_WITH_ATTACHMENTS_FAILED'],
          },
          metadata: {
            type: 'CHAT_WITH_ATTACHMENTS',
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
      const summaryFilename = `${summaryDir}/summary_${Date.now()}.md`;
      try {
        await fs.promises.mkdir(summaryDir, { recursive: true });

        // Write file directly first
        await fs.promises.writeFile(summaryFilename, currentSummary, 'utf8');

        // Then cache it
        await runtime.setCache<string>(summaryFilename, currentSummary);

        await callback(
          {
            ...callbackData,
            text: `I've attached the summary of the requested attachments as a text file.`,
          },
          [summaryFilename]
        );
      } catch (error) {
        console.error('Error in file/cache process:', error);
        throw error;
      }
    } else {
      console.warn('Empty response from chat with attachments action, skipping');
    }

    return callbackData;
  },
  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Can you summarize the attachments b3e23, c4f67, and d5a89?',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "Sure thing! I'll pull up those specific attachments and provide a summary of their content.",
          actions: ['CHAT_WITH_ATTACHMENTS'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'I need a technical summary of the PDFs I sent earlier - a1b2c3.pdf, d4e5f6.pdf, and g7h8i9.pdf',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I'll take a look at those specific PDF attachments and put together a technical summary for you. Give me a few minutes to review them.",
          actions: ['CHAT_WITH_ATTACHMENTS'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: "Can you watch this video for me and tell me which parts you think are most relevant to the report I'm writing? (the one I attached in my last message)",
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'sure, no problem.',
          actions: ['CHAT_WITH_ATTACHMENTS'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'can you read my blog post and give me a detailed breakdown of the key points I made, and then suggest a handful of tweets to promote it?',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'great idea, give me a minute',
          actions: ['CHAT_WITH_ATTACHMENTS'],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;

export default chatWithAttachments;
