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
import { loadPlaylists, savePlaylist } from "../components/playlists";
import {
  getSmartMusicFetchService,
  type MusicFetchProgress,
} from "../utils/smartFetchService";
import { confirmationRequired, isConfirmed } from "./confirmation";

/**
 * ADD_TO_PLAYLIST action - fetch music and add it to a playlist
 */
export const addToPlaylist: Action = {
  name: "ADD_TO_PLAYLIST",
  similes: [
    "ADD_SONG_TO_PLAYLIST",
    "PUT_IN_PLAYLIST",
    "SAVE_TO_PLAYLIST",
    "ADD_TRACK_TO_PLAYLIST",
  ],
  description:
    "Add music to a playlist after confirmed:true. If the track is not already in the library, the configured music fetch service must resolve it first. Creates the playlist if it does not exist.",
  descriptionCompressed:
    "Add track to playlist. Creates playlist if missing. Fetches track if not in library.",
  parameters: [
    {
      name: "confirmed",
      description: "Must be true to add music to the playlist after preview.",
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
    const addToPattern = /add\s+(.+?)\s+to\s+(?:playlist\s+)?(.+)/i;
    const match = messageText.match(addToPattern);

    if (!match) {
      await callback({
        text: 'Please specify what song to add and which playlist. Example: "add Bohemian Rhapsody to my favorites"',
        source: message.content.source,
      });
      return { success: false, error: "Missing song or playlist" };
    }

    const songQuery = match[1].trim();
    const playlistName = match[2].trim();

    if (!songQuery || songQuery.length < 3) {
      await callback({
        text: "Please specify a song name (at least 3 characters).",
        source: message.content.source,
      });
      return { success: false, error: "Missing song name" };
    }

    if (!playlistName || playlistName.length < 2) {
      await callback({
        text: "Please specify a playlist name (at least 2 characters).",
        source: message.content.source,
      });
      return { success: false, error: "Missing playlist name" };
    }

    const preview = `Confirmation required before adding "${songQuery}" to playlist "${playlistName}".`;
    if (!isConfirmed(options)) {
      await callback({
        text: preview,
        source: message.content.source,
      });
      return confirmationRequired(preview, { songQuery, playlistName });
    }

    try {
      const smartFetch = getSmartMusicFetchService(runtime);
      const preferredQuality =
        (runtime.getSetting("MUSIC_QUALITY_PREFERENCE") as string) || "mp3_320";

      await callback({
        text: `Searching for "${songQuery}"...`,
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
          logger.info(`[ADD_TO_PLAYLIST] ${statusText}`);
        }
      };

      const result = await smartFetch.fetchMusic({
        query: songQuery,
        requestedBy: message.entityId,
        onProgress,
        preferredQuality: preferredQuality as "flac" | "mp3_320" | "any",
      });

      if (!result.success || !result.url) {
        await callback({
          text: `Couldn't find or download "${songQuery}". ${result.error || "Please try a different search term."}`,
          source: message.content.source,
        });
        return { success: false, error: result.error || "Music not found" };
      }

      const existingPlaylists = await loadPlaylists(runtime, message.entityId);
      let targetPlaylist = existingPlaylists.find(
        (playlist) =>
          playlist.name.toLowerCase() === playlistName.toLowerCase(),
      );

      if (!targetPlaylist) {
        targetPlaylist = {
          id: crypto.randomUUID(),
          name: playlistName,
          tracks: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
      }

      const trackExists = targetPlaylist.tracks.some(
        (track) => track.url === result.url,
      );

      if (!trackExists) {
        targetPlaylist.tracks.push({
          url: result.url,
          title: result.title || songQuery,
          duration: result.duration,
          addedAt: Date.now(),
        });
        targetPlaylist.updatedAt = Date.now();

        await savePlaylist(runtime, message.entityId, targetPlaylist);

        let responseText = `Added **${result.title || songQuery}** to playlist "${playlistName}"`;
        if (result.source === "torrent") {
          responseText += "\nFetched via torrent";
        }
        responseText += `\nPlaylist now has ${targetPlaylist.tracks.length} track${targetPlaylist.tracks.length !== 1 ? "s" : ""}`;

        await callback({
          text: responseText,
          source: message.content.source,
        });

        await runtime.createMemory(
          {
            entityId: message.entityId,
            agentId: message.agentId,
            roomId: message.roomId,
            content: {
              source: message.content.source,
              thought: `Added ${result.title || songQuery} to playlist ${playlistName} (source: ${result.source})`,
              actions: ["ADD_TO_PLAYLIST"],
            },
            metadata: {
              type: "custom",
              actionName: "ADD_TO_PLAYLIST",
              audioUrl: result.url,
              title: result.title || songQuery,
              playlistName,
              playlistId: targetPlaylist.id,
              source: result.source,
            },
          },
          "messages",
        );

        return { success: true, text: responseText };
      }

      const responseText = `**${result.title || songQuery}** is already in playlist "${playlistName}"`;
      await callback({
        text: responseText,
        source: message.content.source,
      });
      return { success: true, text: responseText };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error("Error in ADD_TO_PLAYLIST action:", errorMessage);

      await callback({
        text: `I encountered an error while trying to add "${songQuery}" to playlist "${playlistName}". ${errorMessage}`,
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
          text: "Add Stairway to Heaven to my rock classics playlist",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll add that to your rock classics playlist!",
          actions: ["ADD_TO_PLAYLIST"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "add some Pink Floyd to playlist chill vibes",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Finding Pink Floyd and adding to chill vibes!",
          actions: ["ADD_TO_PLAYLIST"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "put Bohemian Rhapsody in my favorites",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Adding Bohemian Rhapsody to your favorites!",
          actions: ["ADD_TO_PLAYLIST"],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;

export default addToPlaylist;
