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
  type Service,
  ServiceType,
  type State,
} from "@elizaos/core";
import { mediaUrlTemplate } from "../generated/prompts/typescript/prompts.js";
import { requireActionSpec } from "../generated/specs/spec-helpers";

/**
 * Get a media URL from the user through text input using the provided runtime and state.
 * @param {IAgentRuntime} runtime - The runtime object to interact with the agent.
 * @param {Memory} _message - The memory object containing the input message.
 * @param {State} state - The state of the conversation.
 * @returns {Promise<string | null>} The media URL provided by the user or null if no valid URL is provided.
 */
const getMediaUrl = async (
  runtime: IAgentRuntime,
  _message: Memory,
  state: State
): Promise<string | null> => {
  const prompt = composePromptFromState({
    state,
    template: mediaUrlTemplate,
  });

  for (let i = 0; i < 5; i++) {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });

    const parsedResponse = parseJSONObjectFromText(response) as {
      mediaUrl: string;
    } | null;

    if (parsedResponse?.mediaUrl) {
      return parsedResponse.mediaUrl;
    }
  }
  return null;
};

const spec = requireActionSpec("DOWNLOAD_MEDIA");

export const downloadMedia: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,
  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    return message.content.source === "discord";
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult | undefined> => {
    // Define the expected video service interface
    interface VideoServiceInterface extends Service {
      fetchVideoInfo: (url: string) => Promise<{ title: string; description: string }>;
      downloadVideo: (videoInfo: { title: string; description: string }) => Promise<string>;
    }

    const videoService = runtime.getService<VideoServiceInterface>(ServiceType.VIDEO);

    if (!videoService) {
      runtime.logger.error(
        {
          src: "plugin:discord:action:download-media",
          agentId: runtime.agentId,
        },
        "Video service not found"
      );
      return { success: false, error: "Video service not available" };
    }

    if (!state) {
      if (callback) {
        await callback?.({
          text: "State is not available.",
          source: "discord",
        });
      }
      return { success: false, error: "State is not available" };
    }

    const mediaUrl = await getMediaUrl(runtime, message, state);
    if (!mediaUrl) {
      runtime.logger.warn(
        {
          src: "plugin:discord:action:download-media",
          agentId: runtime.agentId,
        },
        "Could not get media URL from messages"
      );
      await runtime.createMemory(
        {
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            source: "discord",
            thought: "I couldn't find the media URL in the message",
            actions: ["DOWNLOAD_MEDIA_FAILED"],
          },
          metadata: {
            type: MemoryType.CUSTOM,
          },
        },
        "messages"
      );
      return { success: false, error: "Could not get media URL from messages" };
    }

    const videoInfo = await videoService.fetchVideoInfo(mediaUrl);
    const mediaPath = await videoService.downloadVideo(videoInfo);

    const response: Content = {
      text: `I downloaded the video "${videoInfo.title}" and attached it below.`,
      actions: ["DOWNLOAD_MEDIA_RESPONSE"],
      source: message.content.source,
      attachments: [],
    };

    const maxRetries = 3;
    let retries = 0;

    while (retries < maxRetries) {
      try {
        await callback?.({
          ...response,
          attachments: [
            ...(response.attachments || []),
            {
              id: mediaPath,
              url: mediaPath,
              title: "Downloaded Media",
              source: "discord",
              contentType: ContentType.DOCUMENT,
            } as Media,
          ],
        });
        break;
      } catch (error) {
        retries++;
        runtime.logger.error(
          {
            src: "plugin:discord:action:download-media",
            agentId: runtime.agentId,
            attempt: retries,
            error: error instanceof Error ? error.message : String(error),
          },
          "Error sending message"
        );

        if (retries === maxRetries) {
          runtime.logger.error(
            {
              src: "plugin:discord:action:download-media",
              agentId: runtime.agentId,
              maxRetries,
            },
            "Max retries reached, failed to send message with attachment"
          );
          break;
        }

        // Wait for a short delay before retrying
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    return { success: true, ...response };
  },
  examples: (spec.examples ?? []) as ActionExample[][],
};

export default downloadMedia;
