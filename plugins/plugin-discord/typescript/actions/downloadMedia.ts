import {
  type Action,
  type ActionExample,
  type Content,
  ContentType,
  composePromptFromState,
  type HandlerCallback,
  type IAgentRuntime,
  type Media,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  ServiceType,
  type State,
  MemoryType,
} from "@elizaos/core";
import { mediaUrlTemplate } from "../generated/prompts/typescript/prompts.js";

// Re-export for backwards compatibility
export { mediaUrlTemplate };

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
  state: State,
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

export const downloadMedia = {
  name: "DOWNLOAD_MEDIA",
  similes: [
    "DOWNLOAD_VIDEO",
    "DOWNLOAD_AUDIO",
    "GET_MEDIA",
    "DOWNLOAD_PODCAST",
    "DOWNLOAD_YOUTUBE",
  ],
  description:
    "Downloads a video or audio file from a URL and attaches it to the response message.",
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    if (message.content.source !== "discord") {
      return false;
    }
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: any,
    callback: HandlerCallback,
  ) => {
    const videoService = runtime.getService(ServiceType.VIDEO) as any;

    if (!videoService) {
      runtime.logger.error(
        {
          src: "plugin:discord:action:download-media",
          agentId: runtime.agentId,
        },
        "Video service not found",
      );
      return;
    }

    const mediaUrl = await getMediaUrl(runtime, message, state);
    if (!mediaUrl) {
      runtime.logger.warn(
        {
          src: "plugin:discord:action:download-media",
          agentId: runtime.agentId,
        },
        "Could not get media URL from messages",
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
        "messages",
      );
      return;
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
        await callback({
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
          "Error sending message",
        );

        if (retries === maxRetries) {
          runtime.logger.error(
            {
              src: "plugin:discord:action:download-media",
              agentId: runtime.agentId,
              maxRetries,
            },
            "Max retries reached, failed to send message with attachment",
          );
          break;
        }

        // Wait for a short delay before retrying
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    return response;
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Downloading the YouTube video now, one sec",
          actions: ["DOWNLOAD_MEDIA"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Can you grab this video for me? https://vimeo.com/123456789",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Sure thing, I'll download that Vimeo video for you",
          actions: ["DOWNLOAD_MEDIA"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "I need this video downloaded: https://www.youtube.com/watch?v=abcdefg",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "No problem, I'm on it. I'll have that YouTube video downloaded in a jiffy",
          actions: ["DOWNLOAD_MEDIA"],
        },
      },
    ],
  ] as ActionExample[][],
} as unknown as Action;

export default downloadMedia;
