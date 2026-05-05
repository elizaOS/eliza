import {
  type Action,
  type ActionExample,
  type ActionResult,
  ChannelType,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
  type UUID,
} from "@elizaos/core";
import type { MusicLibraryService } from "../services/musicLibraryService";
import { confirmationRequired, isConfirmed } from "./confirmation";

interface MusicQueueService {
  addTrack(
    guildId: string,
    track: {
      url: string;
      title: string;
      duration?: number;
      requestedBy: UUID;
    },
  ): Promise<void>;
}

const MUSIC_SERVICE_NAME = "music";
const MUSIC_LIBRARY_SERVICE_NAME = "musicLibrary";

export const loadPlaylist: Action = {
  name: "LOAD_PLAYLIST",
  similes: [
    "PLAY_PLAYLIST",
    "LOAD_QUEUE",
    "RESTORE_PLAYLIST",
    "PLAY_SAVED_PLAYLIST",
  ],
  description:
    "Load a saved playlist and add all tracks to the queue after confirmed:true. Works best in DMs to avoid flooding group chats.",
  descriptionCompressed: "Load saved playlist, add tracks to queue.",
  parameters: [
    {
      name: "confirmed",
      description: "Must be true to add the playlist tracks to the queue.",
      required: false,
      schema: { type: "boolean", default: false },
    },
  ],
  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ) => {
    if (message.content.source !== "discord") {
      return false;
    }

    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    if (!callback) {
      return { success: false, error: "Missing callback" };
    }

    const musicService = runtime.getService(
      MUSIC_SERVICE_NAME,
    ) as MusicQueueService | null;
    if (!musicService) {
      await callback({
        text: "Music service is not available.",
        source: message.content.source,
      });
      return { success: false, error: "Music service unavailable" };
    }

    const musicLibrary = runtime.getService(
      MUSIC_LIBRARY_SERVICE_NAME,
    ) as MusicLibraryService | null;
    if (!musicLibrary) {
      await callback({
        text: "Music library service is not available.",
        source: message.content.source,
      });
      return { success: false, error: "Music library service unavailable" };
    }

    const room = state?.data?.room || (await runtime.getRoom(message.roomId));
    const currentServerId = room?.serverId;

    if (!currentServerId) {
      await callback({
        text: "I could not determine which server you are in.",
        source: message.content.source,
      });
      return { success: false, error: "Missing server id" };
    }

    const userId = message.entityId as UUID;
    if (!userId) {
      await callback({
        text: "I could not determine your user ID.",
        source: message.content.source,
      });
      return { success: false, error: "Missing user id" };
    }

    try {
      const playlists = await musicLibrary.loadPlaylists(userId);

      if (playlists.length === 0) {
        await callback({
          text: "You don't have any saved playlists. Save a queue first using 'save playlist'.",
          source: message.content.source,
        });
        return { success: false, error: "No playlists available" };
      }

      const messageText = message.content.text || "";
      let playlistName: string | undefined;

      const nameMatch = messageText.match(
        /(?:load|play|restore).*?playlist.*?(?:named|called)?\s*["']?([^"']+)["']?/i,
      );
      if (nameMatch) {
        playlistName = nameMatch[1]?.trim();
      } else {
        const quotedMatch = messageText.match(/["']([^"']+)["']/);
        if (quotedMatch) {
          playlistName = quotedMatch[1]?.trim();
        }
      }

      let selectedPlaylist:
        | Awaited<ReturnType<MusicLibraryService["loadPlaylists"]>>[number]
        | undefined;
      if (playlistName) {
        selectedPlaylist = playlists.find(
          (playlist) =>
            playlist.name.toLowerCase() === playlistName.toLowerCase(),
        );
        if (!selectedPlaylist) {
          await callback({
            text: `I couldn't find a playlist named "${playlistName}". Your playlists: ${playlists.map((p) => `"${p.name}"`).join(", ")}`,
            source: message.content.source,
          });
          return { success: false, error: "Playlist not found" };
        }
      } else {
        selectedPlaylist = [...playlists].sort(
          (a, b) => b.updatedAt - a.updatedAt,
        )[0];
      }

      const preview = `Confirmation required before loading playlist "${selectedPlaylist.name}" and adding ${selectedPlaylist.tracks.length} track${selectedPlaylist.tracks.length !== 1 ? "s" : ""} to the queue.`;
      if (!isConfirmed(options)) {
        await callback({
          text: preview,
          source: message.content.source,
        });
        return confirmationRequired(preview, {
          playlistId: selectedPlaylist.id,
          playlistName: selectedPlaylist.name,
          trackCount: selectedPlaylist.tracks.length,
        });
      }

      for (const track of selectedPlaylist.tracks) {
        await musicService.addTrack(currentServerId, {
          url: track.url,
          title: track.title,
          duration: track.duration,
          requestedBy: userId,
        });
      }

      const isDM = room?.type === ChannelType.DM;
      const addedCount = selectedPlaylist.tracks.length;
      let responseText = `Loaded playlist "${selectedPlaylist.name}" and added ${addedCount} track${addedCount !== 1 ? "s" : ""} to the queue.`;

      if (!isDM) {
        responseText +=
          " Tip: You can manage playlists in DMs to keep group chats clean.";
      }

      await callback({
        text: responseText,
        source: message.content.source,
      });
      return { success: true, text: responseText };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error("Error loading playlist:", errorMessage);
      await callback({
        text: `I encountered an error while loading the playlist. ${errorMessage}`,
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
          text: "load my playlist",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Loaded playlist "My Favorites" and added 5 tracks to the queue.',
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: 'play playlist "Workout Mix"',
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Loaded playlist "Workout Mix" and added 10 tracks to the queue.',
        },
      },
    ],
  ] as ActionExample[][],
};

export default loadPlaylist;
