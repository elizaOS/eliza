import fs from "node:fs";
import {
  type Action,
  type ActionExample,
  type ActionResult,
  ChannelType,
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
  trimTokens,
} from "@elizaos/core";
import {
  attachmentIdsTemplate,
  attachmentSummarizationTemplate as summarizationTemplate,
} from "../generated/prompts/typescript/prompts.js";
import { requireActionSpec } from "../generated/specs/spec-helpers";

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
    if (parsedResponse?.objective && parsedResponse.attachmentIds) {
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

const spec = requireActionSpec("CHAT_WITH_ATTACHMENTS");

export const chatWithAttachments: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,
  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const room = await _runtime.getRoom(message.roomId);

    // Only validate for Discord GROUP channels - this action is Discord-specific
    if (!room || room.type !== ChannelType.GROUP || room.source !== "discord") {
      return false;
    }

    // only show if one of the keywords are in the message
    const keywords: string[] = [
      "attachment",
      "summary",
      "summarize",
      "research",
      "pdf",
      "video",
      "audio",
      "image",
      "document",
      "link",
      "file",
      "attachment",
      "summarize",
      "code",
      "report",
      "write",
      "details",
      "information",
      "talk",
      "chat",
      "read",
      "listen",
      "watch",
    ];
    const messageContentText = message.content.text;
    return keywords.some((keyword) =>
      messageContentText?.toLowerCase().includes(keyword.toLowerCase())
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult | undefined> => {
    if (!state) {
      if (callback) {
        await callback?.({
          text: "State is not available.",
          source: "discord",
        });
      }
      return { success: false, error: "State is not available" };
    }
    const callbackData: Content = {
      text: "", // fill in later
      actions: ["CHAT_WITH_ATTACHMENTS_RESPONSE"],
      source: message.content.source,
      attachments: [],
    };

    // 1. extract attachment IDs from the message
    const attachmentData = await getAttachmentIds(runtime, message, state);
    if (!attachmentData) {
      runtime.logger.warn(
        {
          src: "plugin:discord:action:chat-with-attachments",
          agentId: runtime.agentId,
        },
        "Could not get attachment IDs from message"
      );
      await runtime.createMemory(
        {
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            source: message.content.source,
            thought: "I tried to chat with attachments but I couldn't get attachment IDs",
            actions: ["CHAT_WITH_ATTACHMENTS_FAILED"],
          },
          metadata: {
            type: MemoryType.CUSTOM,
          },
        },
        "messages"
      );
      return { success: false, error: "Could not get attachment IDs from message" };
    }

    const { objective, attachmentIds } = attachmentData;

    const conversationLength = runtime.getConversationLength();

    const recentMessages = await runtime.getMemories({
      tableName: "messages",
      roomId: message.roomId,
      count: conversationLength,
      unique: false,
    });

    // This is pretty gross but it can catch cases where the returned generated UUID is stupidly wrong for some reason
    const attachments = recentMessages
      .filter((msg) => msg.content.attachments && msg.content.attachments.length > 0)
      .flatMap((msg) => msg.content.attachments)
      // Ensure attachment is not undefined before accessing properties
      .filter(
        (attachment) =>
          attachment &&
          (attachmentIds
            .map((attch) => attch.toLowerCase().slice(0, 5))
            .includes(attachment.id.toLowerCase().slice(0, 5)) ||
            // or check the other way
            attachmentIds.some((id) => {
              const attachmentId = id.toLowerCase().slice(0, 5);
              // Add check here too
              return attachment?.id?.toLowerCase().includes(attachmentId);
            }))
      );

    const attachmentsWithText = attachments
      // Ensure attachment is not undefined before accessing properties
      .filter((attachment): attachment is NonNullable<typeof attachment> => !!attachment)
      .map((attachment) => `# ${attachment.title}\n${attachment.text}`)
      .join("\n\n");

    let currentSummary = "";

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
      runtime.logger.warn(
        {
          src: "plugin:discord:action:chat-with-attachments",
          agentId: runtime.agentId,
        },
        "No summary found"
      );
      await runtime.createMemory(
        {
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            source: message.content.source,
            thought: "I tried to chat with attachments but I couldn't get a summary",
            actions: ["CHAT_WITH_ATTACHMENTS_FAILED"],
          },
          metadata: {
            type: MemoryType.CUSTOM,
          },
        },
        "messages"
      );
      return { success: false, error: "No summary found" };
    }

    callbackData.text = currentSummary.trim();
    const trimmedSummary = currentSummary.trim();
    if (
      callbackData.text &&
      ((trimmedSummary && trimmedSummary.split("\n").length < 4) ||
        (trimmedSummary && trimmedSummary.split(" ").length < 100))
    ) {
      callbackData.text = `Here is the summary:
\`\`\`md
${currentSummary.trim()}
\`\`\`
`;
      if (callback) {
        await callback?.(callbackData);
      }
      return { success: true, text: callbackData.text };
    } else if (currentSummary.trim()) {
      const summaryDir = "cache";
      const summaryFilename = `${summaryDir}/summary_${Date.now()}.md`;
      try {
        await fs.promises.mkdir(summaryDir, { recursive: true });

        // Write file directly first
        await fs.promises.writeFile(summaryFilename, currentSummary, "utf8");

        // Then cache it
        await runtime.setCache<string>(summaryFilename, currentSummary);

        if (callback) {
          await callback?.({
            ...callbackData,
            text: "I've attached the summary of the requested attachments as a text file.",
            attachments: [
              ...(callbackData.attachments || []),
              {
                id: summaryFilename,
                url: summaryFilename,
                title: "Summary",
                source: "discord",
                contentType: ContentType.DOCUMENT,
              } as Media,
            ],
          });
        }
        return { success: true, text: `Summary saved to ${summaryFilename}` };
      } catch (error) {
        runtime.logger.error(
          {
            src: "plugin:discord:action:chat-with-attachments",
            agentId: runtime.agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Error in file/cache process"
        );
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    } else {
      runtime.logger.warn(
        {
          src: "plugin:discord:action:chat-with-attachments",
          agentId: runtime.agentId,
        },
        "Empty response from chat with attachments action"
      );
      return { success: false, error: "Empty response from chat with attachments action" };
    }
  },
  examples: (spec.examples ?? []) as ActionExample[][],
};

export default chatWithAttachments;
