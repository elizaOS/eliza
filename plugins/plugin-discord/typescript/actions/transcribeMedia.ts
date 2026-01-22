import {
  type Action,
  type ActionExample,
  type ActionResult,
  type Content,
  ContentType,
  composePromptFromState,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Media,
  type Memory,
  MemoryType,
  ModelType,
  parseJSONObjectFromText,
  type State,
} from "@elizaos/core";
import { mediaAttachmentIdTemplate } from "../generated/prompts/typescript/prompts.js";
import { requireActionSpec } from "../generated/specs/spec-helpers";

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
const spec = requireActionSpec("TRANSCRIBE_MEDIA");

export const transcribeMedia: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,
  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    if (message.content.source !== "discord") {
      return false;
    }

    const keywords: string[] = [
      "transcribe",
      "transcript",
      "audio",
      "video",
      "media",
      "youtube",
      "meeting",
      "recording",
      "podcast",
      "call",
      "conference",
      "interview",
      "speech",
      "lecture",
      "presentation",
    ];
    return keywords.some((keyword) =>
      message.content.text?.toLowerCase().includes(keyword.toLowerCase())
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult | undefined> => {
    const callbackData: Content = {
      text: "", // fill in later
      actions: ["TRANSCRIBE_MEDIA_RESPONSE"],
      source: message.content.source,
      attachments: [],
    };

    const attachmentId = await getMediaAttachmentId(runtime, message, state);
    if (!attachmentId) {
      runtime.logger.warn(
        {
          src: "plugin:discord:action:transcribe-media",
          agentId: runtime.agentId,
        },
        "Could not get media attachment ID from message"
      );
      await runtime.createMemory(
        {
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            source: "discord",
            thought: "I couldn't find the media attachment ID in the message",
            actions: ["TRANSCRIBE_MEDIA_FAILED"],
          },
          metadata: {
            type: MemoryType.CUSTOM,
          },
        },
        "messages"
      );
      return;
    }

    const conversationLength = runtime.getConversationLength();

    const recentMessages = await runtime.getMemories({
      tableName: "messages",
      roomId: message.roomId,
      count: conversationLength,
      unique: false,
    });

    const attachment = recentMessages
      .filter((msg) => msg.content.attachments && msg.content.attachments.length > 0)
      .flatMap((msg) => msg.content.attachments)
      .find(
        (attachment) => attachment && attachment.id.toLowerCase() === attachmentId.toLowerCase()
      );

    if (!attachment) {
      runtime.logger.warn(
        {
          src: "plugin:discord:action:transcribe-media",
          agentId: runtime.agentId,
          attachmentId,
        },
        "Could not find attachment"
      );
      await runtime.createMemory(
        {
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            source: "discord",
            thought: `I couldn't find the media attachment with ID ${attachmentId}`,
            actions: ["TRANSCRIBE_MEDIA_FAILED"],
          },
          metadata: {
            type: MemoryType.CUSTOM,
          },
        },
        "messages"
      );
      return;
    }

    const mediaTranscript = attachment.text;

    callbackData.text = mediaTranscript?.trim();

    // if callbackData.text is < 4 lines or < 100 words, then we we callback with normal message wrapped in markdown block
    if (
      callbackData.text &&
      (callbackData.text.split("\n").length < 4 || callbackData.text.split(" ").length < 100)
    ) {
      callbackData.text = `Here is the transcript:
\`\`\`md
${mediaTranscript?.trim() || ""}
\`\`\`
`;
      await callback?.(callbackData);
    }
    // if text is big, let's send as an attachment
    else if (callbackData.text) {
      const transcriptFilename = `content/transcript_${Date.now()}`;

      // save the transcript to a file
      await runtime.setCache<string>(transcriptFilename, callbackData.text);

      await callback?.({
        ...callbackData,
        text: "I've attached the transcript as a text file.",
        attachments: [
          ...(callbackData.attachments || []),
          {
            id: transcriptFilename,
            url: transcriptFilename,
            title: "Transcript",
            source: "discord",
            contentType: ContentType.DOCUMENT,
          } as Media,
        ],
      });
    } else {
      runtime.logger.warn(
        {
          src: "plugin:discord:action:transcribe-media",
          agentId: runtime.agentId,
        },
        "Empty response from transcribe media action"
      );
    }

    return { success: true, text: callbackData.text };
  },
  examples: (spec.examples ?? []) as ActionExample[][],
};

export default transcribeMedia;
