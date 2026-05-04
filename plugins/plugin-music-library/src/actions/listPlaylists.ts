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

const MUSIC_LIBRARY_SERVICE_NAME = "musicLibrary";

export const listPlaylists: Action = {
  name: "LIST_PLAYLISTS",
  similes: [
    "SHOW_PLAYLISTS",
    "MY_PLAYLISTS",
    "PLAYLIST_LIST",
    "VIEW_PLAYLISTS",
  ],
  description:
    "List all saved playlists for the user. Works best in DMs to avoid flooding group chats.",
  descriptionCompressed: "List all saved playlists.",
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
    _options?: Record<string, unknown>,
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
          text: "You don't have any saved playlists. Save a queue first using 'save playlist'.",
          source: message.content.source,
        });
        return { success: false, error: "No playlists available" };
      }

      const sortedPlaylists = [...playlists].sort(
        (a, b) => b.updatedAt - a.updatedAt,
      );

      const room = state?.data?.room || (await runtime.getRoom(message.roomId));
      const isDM = room?.type === ChannelType.DM;

      let text = `**Your Playlists (${sortedPlaylists.length}):**\n\n`;
      for (const playlist of sortedPlaylists) {
        const date = new Date(playlist.updatedAt).toLocaleDateString();
        text += `• **${playlist.name}** - ${playlist.tracks.length} track${playlist.tracks.length !== 1 ? "s" : ""} (updated ${date})\n`;
      }

      if (!isDM) {
        text += `\n💡 **Tip:** You can manage playlists in DMs to keep group chats clean! Just send me a DM and I'll help you manage your playlists privately.`;
      }

      await callback({
        text,
        source: message.content.source,
      });
      return { success: true, text };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error("Error listing playlists:", errorMessage);
      await callback({
        text: `I encountered an error while listing your playlists. ${errorMessage}`,
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
          text: "show my playlists",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "**Your Playlists (2):**\n\n• **My Favorites** - 5 tracks (updated 12/25/2024)\n• **Workout Mix** - 10 tracks (updated 12/24/2024)",
        },
      },
    ],
  ] as ActionExample[][],
};

export default listPlaylists;
