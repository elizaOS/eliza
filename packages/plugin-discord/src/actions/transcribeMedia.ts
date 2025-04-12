import {
  type Action,
  type ActionExample,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type State,
  composePromptFromState,
  createUniqueUuid,
  parseJSONObjectFromText,
} from '@elizaos/core';

export const transcriptionTemplate = `# Transcription of media file
{{mediaTranscript}}

# Instructions: Return only the full transcript of the media file without any additional prompt or commentary.`;

/**
 * Template for generating media attachment ID request for transcription
 *
 * @type {string}
 */
export const mediaAttachmentIdTemplate = `# Messages we are transcribing
{{recentMessages}}

# Instructions: {{senderName}} is requesting a transcription of a specific media file (audio or video). Your goal is to determine the ID of the attachment they want transcribed.
The "attachmentId" is the ID of the media file attachment that the user wants transcribed. If not specified, return null.

Your response must be formatted as a JSON block with this structure:
\`\`\`json
{
  "attachmentId": "<Attachment ID>"
}
\`\`\`
`;

/**
 * Asynchronous function to get the media attachment ID from the user input.
 *
 * @param {IAgentRuntime} runtime - The agent runtime object.
 * @param {Memory} _message - The memory object.
 * @param {State} state - The current state of the conversation.
 * @returns {Promise<string | null>} A promise that resolves with the media attachment ID or null.
 */
const getMediaAttachmentId = async (
  runtime: IAgentRuntime,
  _message: Memory,
  state: State
): Promise<string | null> => {
  const prompt = composePromptFromState({
    state,
    template: mediaAttachmentIdTemplate,
  });

  for (let i = 0; i < 5; i++) {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });

    const parsedResponse = parseJSONObjectFromText(response) as {
      attachmentId: string;
    } | null;

    if (parsedResponse?.attachmentId) {
      return parsedResponse.attachmentId;
    }
  }
  return null;
};

/**
 * Action for transcribing the full text of an audio or video file that the user has attached.
 *
 * @typedef {Object} Action
 * @property {string} name - The name of the action.
 * @property {string[]} similes - Similes associated with the action.
 * @property {string} description - Description of the action.
 * @property {Function} validate - Validation function for the action.
 * @property {Function} handler - Handler function for the action.
 * @property {ActionExample[][]} examples - Examples demonstrating the action.
 */
export const transcribeMedia: Action = {
  name: 'TRANSCRIBE_MEDIA',
  similes: [
    'TRANSCRIBE_AUDIO',
    'TRANSCRIBE_VIDEO',
    'MEDIA_TRANSCRIPT',
    'VIDEO_TRANSCRIPT',
    'AUDIO_TRANSCRIPT',
  ],
  description: 'Transcribe the full text of an audio or video file that the user has attached.',
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    if (message.content.source !== 'discord') {
      return false;
    }

    const keywords: string[] = [
      'transcribe',
      'transcript',
      'audio',
      'video',
      'media',
      'youtube',
      'meeting',
      'recording',
      'podcast',
      'call',
      'conference',
      'interview',
      'speech',
      'lecture',
      'presentation',
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
      actions: ['TRANSCRIBE_MEDIA_RESPONSE'],
      source: message.content.source,
      attachments: [],
    };

    const attachmentId = await getMediaAttachmentId(runtime, message, state);
    if (!attachmentId) {
      console.error("Couldn't get media attachment ID from message");
      await runtime.createMemory(
        {
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            source: 'discord',
            thought: `I couldn't find the media attachment ID in the message`,
            actions: ['TRANSCRIBE_MEDIA_FAILED'],
          },
          metadata: {
            type: 'TRANSCRIBE_MEDIA',
          },
        },
        'messages'
      );
      return;
    }

    const conversationLength = runtime.getConversationLength();

    const recentMessages = await runtime.getMemories({
      tableName: 'messages',
      roomId: message.roomId,
      count: conversationLength,
      unique: false,
    });

    const attachment = recentMessages
      .filter((msg) => msg.content.attachments && msg.content.attachments.length > 0)
      .flatMap((msg) => msg.content.attachments)
      .find((attachment) => attachment.id.toLowerCase() === attachmentId.toLowerCase());

    if (!attachment) {
      console.error(`Couldn't find attachment with ID ${attachmentId}`);
      await runtime.createMemory(
        {
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            source: 'discord',
            thought: `I couldn't find the media attachment with ID ${attachmentId}`,
            actions: ['TRANSCRIBE_MEDIA_FAILED'],
          },
          metadata: {
            type: 'TRANSCRIBE_MEDIA',
          },
        },
        'messages'
      );
      return;
    }

    const mediaTranscript = attachment.text;

    callbackData.text = mediaTranscript.trim();

    // if callbackData.text is < 4 lines or < 100 words, then we we callback with normal message wrapped in markdown block
    if (
      callbackData.text &&
      (callbackData.text?.split('\n').length < 4 || callbackData.text?.split(' ').length < 100)
    ) {
      callbackData.text = `Here is the transcript:
\`\`\`md
${mediaTranscript.trim()}
\`\`\`
`;
      await callback(callbackData);
    }
    // if text is big, let's send as an attachment
    else if (callbackData.text) {
      const transcriptFilename = `content/transcript_${Date.now()}`;

      // save the transcript to a file
      await runtime.setCache<string>(transcriptFilename, callbackData.text);

      await callback(
        {
          ...callbackData,
          text: `I've attached the transcript as a text file.`,
        },
        [transcriptFilename]
      );
    } else {
      console.warn('Empty response from transcribe media action, skipping');
    }

    return callbackData;
  },
  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Please transcribe the audio file I just sent.',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "Sure, I'll transcribe the full audio for you.",
          actions: ['TRANSCRIBE_MEDIA'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Can I get a transcript of that video recording?',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Absolutely, give me a moment to generate the full transcript of the video.',
          actions: ['TRANSCRIBE_MEDIA'],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;

export default transcribeMedia;
