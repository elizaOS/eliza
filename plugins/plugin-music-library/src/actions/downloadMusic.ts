import {
  type Action,
  type ActionExample,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import {
  getSmartMusicFetchService,
  type MusicFetchProgress,
} from "../utils/smartFetchService";
import { confirmationRequired, isConfirmed } from "./confirmation";

/**
 * DOWNLOAD_MUSIC action - downloads music to library without playing
 */
export const downloadMusic: Action = {
  name: "DOWNLOAD_MUSIC",
  similes: [
    "FETCH_MUSIC",
    "GET_MUSIC",
    "DOWNLOAD_SONG",
    "SAVE_MUSIC",
    "GRAB_MUSIC",
  ],
  description:
    "Download music to the local library without playing it. Requires confirmed:true before fetching and saving.",
  descriptionCompressed: "Download track to library without playing.",
  parameters: [
    {
      name: "confirmed",
      description: "Must be true to download music after preview.",
      required: false,
      schema: { type: "boolean", default: false },
    },
  ],
  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ) => {
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    options: Record<string, unknown> | undefined,
    callback: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const messageText = message.content.text || "";
    const query = messageText.trim();

    if (!query || query.length < 3) {
      await callback({
        text: "Please tell me what song you'd like to download (at least 3 characters).",
        source: message.content.source,
      });
      return;
    }

    const preview = `Confirmation required before downloading music to the library: "${query}".`;
    if (!isConfirmed(options)) {
      await callback({
        text: preview,
        source: message.content.source,
      });
      return confirmationRequired(preview, { query });
    }

    try {
      const smartFetch = getSmartMusicFetchService(runtime);
      const preferredQuality =
        (runtime.getSetting("MUSIC_QUALITY_PREFERENCE") as string) || "mp3_320";

      await callback({
        text: `Searching for "${query}"...`,
        source: message.content.source,
      });

      let lastProgress = "";
      const onProgress = async (progress: MusicFetchProgress) => {
        const progressLabel = progress.stage || progress.message || "working";
        const statusText = progress.details
          ? `${progressLabel}: ${String(progress.details)}`
          : progressLabel;
        if (statusText !== lastProgress) {
          lastProgress = statusText;
          logger.info(`[DOWNLOAD_MUSIC] ${statusText}`);
          await callback({
            text: statusText,
            source: message.content.source,
          });
        }
      };

      const result = await smartFetch.fetchMusic({
        query,
        requestedBy: message.entityId,
        onProgress,
        preferredQuality: preferredQuality as "flac" | "mp3_320" | "any",
      });

      if (!result.success || !result.url) {
        await callback({
          text: `Couldn't find or download "${query}". ${result.error || "Please try a different search term."}`,
          source: message.content.source,
        });
        return;
      }

      let sourceText = "";
      if (result.source === "library") {
        sourceText = "Already in your library";
      } else if (result.source === "ytdlp") {
        sourceText = "Fetched from streaming service";
      } else if (result.source === "torrent") {
        sourceText = "Fetched via torrent";
      }

      const responseText = `**${result.title || query}** - ${sourceText}\nAvailable in your music library`;

      await runtime.createMemory(
        {
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            source: message.content.source,
            thought: `Downloaded music: ${result.title || query} (source: ${result.source})`,
            actions: ["DOWNLOAD_MUSIC"],
          },
          metadata: {
            type: "custom",
            actionName: "DOWNLOAD_MUSIC",
            audioUrl: result.url,
            title: result.title || query,
            source: result.source,
          },
        },
        "messages",
      );

      await callback({
        text: responseText,
        source: message.content.source,
      });
      return { success: true, text: responseText };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error("Error in DOWNLOAD_MUSIC action:", errorMessage);

      await callback({
        text: `I encountered an error while trying to download "${query}". ${errorMessage}`,
        source: message.content.source,
      });
      return { success: false, error: errorMessage };
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Download Comfortably Numb by Pink Floyd",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll download that to your library!",
          actions: ["DOWNLOAD_MUSIC"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "fetch some Led Zeppelin for me",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Searching and downloading Led Zeppelin!",
          actions: ["DOWNLOAD_MUSIC"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "grab the entire Dark Side of the Moon album",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll download that album for you!",
          actions: ["DOWNLOAD_MUSIC"],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;

export default downloadMusic;
