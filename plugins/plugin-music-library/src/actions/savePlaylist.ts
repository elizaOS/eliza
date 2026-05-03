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
import type { Playlist } from "../components/playlists";
import type { MusicLibraryService } from "../services/musicLibraryService";
import { confirmationRequired, isConfirmed } from "./confirmation";

interface QueueTrack {
  url: string;
  title: string;
  duration?: number;
}

interface MusicQueueReadService {
  getQueueList(guildId: string): QueueTrack[];
  getCurrentTrack(guildId: string): QueueTrack | null;
}

const MUSIC_SERVICE_NAME = "music";
const MUSIC_LIBRARY_SERVICE_NAME = "musicLibrary";

export const savePlaylist: Action = {
  name: "SAVE_PLAYLIST",
  similes: [
    "SAVE_QUEUE",
    "CREATE_PLAYLIST",
    "STORE_PLAYLIST",
    "SAVE_MUSIC_LIST",
  ],
  description:
    "Save the current music queue as a playlist for the user after confirmed:true. Works best in DMs to avoid flooding group chats.",
  descriptionCompressed: "Save current queue as playlist.",
  parameters: [
    {
      name: "confirmed",
      description: "Must be true to save the current queue as a playlist.",
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
    ) as MusicQueueReadService | null;
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

    const queue = musicService.getQueueList(currentServerId);
    const currentTrack = musicService.getCurrentTrack(currentServerId);

    if (queue.length === 0 && !currentTrack) {
      await callback({
        text: "The queue is empty. Add some tracks before saving a playlist.",
        source: message.content.source,
      });
      return { success: false, error: "Queue is empty" };
    }

    const messageText = message.content.text || "";
    const nameMatch = messageText.match(
      /(?:save|create|store).*?playlist.*?(?:named|called|as)?\s*["']?([^"']+)["']?/i,
    );
    const playlistName =
      nameMatch?.[1]?.trim() || `Playlist ${new Date().toLocaleDateString()}`;

    try {
      const userId = message.entityId as UUID;
      if (!userId) {
        await callback({
          text: "I could not determine your user ID.",
          source: message.content.source,
        });
        return { success: false, error: "Missing user id" };
      }

      const tracks: Array<{ url: string; title: string; duration?: number }> =
        [];
      if (currentTrack) {
        tracks.push({
          url: currentTrack.url,
          title: currentTrack.title,
          duration: currentTrack.duration,
        });
      }
      for (const track of queue) {
        tracks.push({
          url: track.url,
          title: track.title,
          duration: track.duration,
        });
      }

      const playlist: Omit<Playlist, "id" | "createdAt" | "updatedAt"> = {
        name: playlistName,
        tracks,
      };

      const preview = `Confirmation required before saving playlist "${playlistName}" with ${tracks.length} track${tracks.length !== 1 ? "s" : ""}.`;
      if (!isConfirmed(options)) {
        await callback({
          text: preview,
          source: message.content.source,
        });
        return confirmationRequired(preview, {
          playlistName,
          trackCount: tracks.length,
        });
      }

      const savedPlaylist = await musicLibrary.savePlaylist(userId, playlist);

      const isDM = room?.type === ChannelType.DM;

      let responseText = `Saved playlist "${savedPlaylist.name}" with ${savedPlaylist.tracks.length} track${savedPlaylist.tracks.length !== 1 ? "s" : ""}.`;

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
      logger.error("Error saving playlist:", errorMessage);
      await callback({
        text: `I encountered an error while saving the playlist. ${errorMessage}`,
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
          text: "save this as a playlist",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Saved playlist "Playlist 12/25/2024" with 5 tracks.',
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: 'create a playlist called "My Favorites"',
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Saved playlist "My Favorites" with 3 tracks.',
        },
      },
    ],
  ] as ActionExample[][],
};

export default savePlaylist;
