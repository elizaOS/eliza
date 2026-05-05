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
import { MusicService } from "../service";
import { SmartMusicFetchService } from "../services/smartMusicFetch";
import { ProgressiveMessage } from "../utils/progressiveMessage";
import { confirmationRequired, isConfirmed } from "./confirmation";

/**
 * QUEUE_MUSIC action - adds music to queue without playing immediately
 * Uses smart fallback like PLAY_MUSIC
 */
export const queueMusic: Action = {
  name: "QUEUE_MUSIC",
  similes: ["ADD_TO_QUEUE", "QUEUE_SONG", "QUEUE_TRACK", "ADD_SONG"],
  description: "Add a song to the queue for later after confirmed:true.",
  descriptionCompressed: "Queue song for later.",
  parameters: [
    {
      name: "confirmed",
      description: "Must be true to fetch and add the song to the queue.",
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
    state: State | undefined,
    options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    if (!callback) return { success: false, error: "Missing callback" };
    const messageText = message.content.text || "";
    const query = messageText.trim();
    if (!query || query.length < 3) {
      await callback({
        text: "Please tell me what song you'd like to queue (at least 3 characters).",
        source: message.content.source || "discord",
      });
      return { success: false, error: "Missing queue query" };
    }

    const preview = `Confirmation required before adding "${query}" to the music queue.`;
    if (!isConfirmed(options)) {
      await callback({
        text: preview,
        source: message.content.source || "discord",
      });
      return confirmationRequired(preview, { query });
    }

    // Create progressive message helper
    //
    // Why use ProgressiveMessage: queueMusic uses SmartMusicFetchService which
    // tries library → YouTube → torrents in sequence. This can take 10-30+ seconds.
    // The onProgress callback already provides granular status - we wire it to
    // ProgressiveMessage to show those updates to users.
    const progress = new ProgressiveMessage(
      callback,
      message.content.source || "discord",
    );

    try {
      // Initial status
      progress.update("🔍 Looking up track...");

      const smartFetch = new SmartMusicFetchService(runtime);
      const preferredQuality =
        (runtime.getSetting("MUSIC_QUALITY_PREFERENCE") as string) || "mp3_320";

      // Wire SmartMusicFetch's progress callbacks to ProgressiveMessage
      //
      // Why deduplicate: SmartMusicFetch can emit the same status multiple times
      // (e.g., "Searching torrents" while polling). We only send updates when
      // status actually changes to avoid spamming Discord edits.
      //
      // Why all marked important: SmartMusicFetch only emits status for long
      // operations (searching, downloading). These are all worth showing even
      // on non-editing platforms.
      let lastProgress = "";
      const onProgress = async (progressInfo: any) => {
        const statusText = `${progressInfo.status}${progressInfo.details ? `: ${progressInfo.details}` : ""}`;
        if (statusText !== lastProgress) {
          lastProgress = statusText;
          logger.info(`[QUEUE_MUSIC] ${statusText}`);
          // Send progressive update (important: these are all slow operations)
          progress.update(
            `🔍 ${progressInfo.status}${progressInfo.details ? `: ${progressInfo.details}` : ""}`,
            { important: true },
          );
        }
      };

      const result = await smartFetch.fetchMusic({
        query,
        requestedBy: message.entityId,
        onProgress,
        preferredQuality: preferredQuality as "flac" | "mp3_320" | "any",
      });

      if (!result.success || !result.url) {
        await progress.fail(
          `❌ Couldn't find or download "${query}". ${result.error || "Please try a different search term."}`,
        );
        return;
      }

      // Final setup step (fast, transient)
      //
      // Why no "important": Adding to queue is instant (< 50ms). This is just
      // a polish update for Discord users - not worth showing on web/CLI.
      progress.update("✨ Adding to queue...");

      const room = state?.data?.room || (await runtime.getRoom(message.roomId));
      let currentServerId = room?.serverId;

      if (!currentServerId) {
        currentServerId =
          message.content.source === "discord"
            ? room?.serverId || message.roomId
            : `web-${message.roomId}`;
      } else if (message.content.source !== "discord") {
        currentServerId = `web-${currentServerId}`;
      }

      // Use entityId (UUID) not fromId (Discord snowflake) for requestedBy
      // WHY: fromId in metadata is the raw Discord snowflake ID for security reference
      // entityId is the proper UUID created by createUniqueUuid(runtime, discordId)
      const requestUserId = message.entityId;

      let musicService = runtime.getService("music") as unknown as MusicService;
      if (!musicService) {
        musicService = new MusicService(runtime);
      }

      // Get queue state BEFORE adding track
      const queueLength = musicService.getQueueList(currentServerId).length;
      const position = queueLength + 1; // Position after adding

      let sourceEmoji = "";
      if (result.source === "library") {
        sourceEmoji = "📚";
      } else if (result.source === "ytdlp") {
        sourceEmoji = "🎬";
      } else if (result.source === "torrent") {
        sourceEmoji = "🌊";
      }

      let responseText = `${sourceEmoji} Added to queue (position ${position}): **${query}**`;
      if (result.source === "torrent") {
        responseText += "\n_Downloaded via torrent and added to your library_";
      }

      // Add track to queue
      const track = await musicService.addTrack(currentServerId, {
        url: result.url,
        title: query,
        requestedBy: requestUserId,
      });

      // WHY entityId = agentId: same rationale as playAudio — this is
      // an agent action log, not a user message.
      runtime
        .createMemory(
          {
            entityId: runtime.agentId,
            agentId: message.agentId,
            roomId: message.roomId,
            content: {
              source: "action",
              thought: `Queued music: ${query} (source: ${result.source})`,
              actions: ["QUEUE_MUSIC"],
            },
            metadata: {
              type: "custom" as const,
              kind: "QUEUE_MUSIC",
              audioUrl: result.url,
              title: query,
              trackId: track.id,
              source: result.source,
            },
          },
          "messages",
        )
        .catch((error) => logger.warn(`Failed to create memory: ${error}`));

      await progress.complete(responseText);
      return { success: true, text: responseText };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error("Error in QUEUE_MUSIC action:", errorMessage);

      await progress.fail(
        `❌ I encountered an error while trying to queue "${query}". ${errorMessage}`,
      );
      return { success: false, error: errorMessage };
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Queue Hotel California",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll add that to the queue!",
          actions: ["QUEUE_MUSIC"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "add some Beatles to the queue",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Searching for Beatles and adding to queue!",
          actions: ["QUEUE_MUSIC"],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;

export default queueMusic;
