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

const MUSIC_LIBRARY_SERVICE_NAME = "musicLibrary";

export const deletePlaylist: Action = {
  name: "DELETE_PLAYLIST",
  similes: [
    "REMOVE_PLAYLIST",
    "DELETE_SAVED_PLAYLIST",
    "REMOVE_SAVED_PLAYLIST",
  ],
  description:
    "Delete a saved playlist after confirmed:true. Works best in DMs to avoid flooding group chats.",
  descriptionCompressed: "Delete saved playlist.",
  parameters: [
    {
      name: "confirmed",
      description: "Must be true to delete the saved playlist after preview.",
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
          text: "You don't have any saved playlists to delete.",
          source: message.content.source,
        });
        return { success: false, error: "No playlists available" };
      }

      const messageText = message.content.text || "";
      let playlistName: string | undefined;

      const nameMatch = messageText.match(
        /(?:delete|remove).*?playlist.*?(?:named|called)?\s*["']?([^"']+)["']?/i,
      );
      if (nameMatch) {
        playlistName = nameMatch[1]?.trim();
      } else {
        const quotedMatch = messageText.match(/["']([^"']+)["']/);
        if (quotedMatch) {
          playlistName = quotedMatch[1]?.trim();
        }
      }

      if (!playlistName) {
        const playlistList = playlists
          .map((playlist) => `"${playlist.name}"`)
          .join(", ");
        await callback({
          text: `Please specify which playlist to delete. Your playlists: ${playlistList}\n\nExample: "delete playlist My Favorites"`,
          source: message.content.source,
        });
        return { success: false, error: "Missing playlist name" };
      }

      const selectedPlaylist = playlists.find(
        (playlist) =>
          playlist.name.toLowerCase() === playlistName.toLowerCase(),
      );

      if (!selectedPlaylist) {
        const playlistList = playlists
          .map((playlist) => `"${playlist.name}"`)
          .join(", ");
        await callback({
          text: `I couldn't find a playlist named "${playlistName}". Your playlists: ${playlistList}`,
          source: message.content.source,
        });
        return { success: false, error: "Playlist not found" };
      }

      const preview = `Confirmation required before deleting playlist "${selectedPlaylist.name}" (${selectedPlaylist.tracks.length} track${selectedPlaylist.tracks.length !== 1 ? "s" : ""}).`;
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

      const deleted = await musicLibrary.deletePlaylist(
        userId,
        selectedPlaylist.id,
      );

      if (!deleted) {
        await callback({
          text: "I encountered an error while deleting the playlist.",
          source: message.content.source,
        });
        return { success: false, error: "Delete failed" };
      }

      const room = state?.data?.room || (await runtime.getRoom(message.roomId));
      const isDM = room?.type === ChannelType.DM;

      let responseText = `Deleted playlist "${selectedPlaylist.name}".`;

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
      logger.error("Error deleting playlist:", errorMessage);
      await callback({
        text: `I encountered an error while deleting the playlist. ${errorMessage}`,
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
          text: 'delete playlist "My Favorites"',
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Deleted playlist "My Favorites".',
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "remove playlist Workout Mix",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Deleted playlist "Workout Mix".',
        },
      },
    ],
  ] as ActionExample[][],
};

export default deletePlaylist;
