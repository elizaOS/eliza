import {
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
  type UUID,
} from "@elizaos/core";
import type { MusicLibraryService } from "../services/musicLibraryService";

const MUSIC_LIBRARY_SERVICE_NAME = "musicLibrary";
const DEFAULT_LIMIT = 20;

export const musicPlaylistsProvider: Provider = {
  name: "musicPlaylists",
  description: "Saved playlists for the requesting user as JSON context.",
  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    try {
      const userId = message.entityId as UUID | undefined;
      if (!userId) return { text: "" };

      const musicLibrary = runtime.getService(
        MUSIC_LIBRARY_SERVICE_NAME,
      ) as MusicLibraryService | null;
      if (!musicLibrary) return { text: "" };

      const playlists = await musicLibrary.loadPlaylists(userId);
      if (playlists.length === 0) {
        return {
          text: JSON.stringify(
            {
              music_playlists: {
                count: 0,
                items: [],
                note: "No saved playlists.",
              },
            },
            null,
            2,
          ),
        };
      }

      const sorted = [...playlists].sort((a, b) => b.updatedAt - a.updatedAt);
      const items = sorted.slice(0, DEFAULT_LIMIT).map((p) => ({
        id: p.id,
        name: p.name,
        track_count: p.tracks.length,
        updated_at: p.updatedAt,
      }));

      return {
        text: JSON.stringify(
          {
            music_playlists: {
              count: sorted.length,
              items,
              truncated: sorted.length > DEFAULT_LIMIT,
            },
          },
          null,
          2,
        ),
      };
    } catch (error) {
      logger.error(
        "Error in musicPlaylists provider:",
        error instanceof Error ? error.message : String(error),
      );
      return { text: "" };
    }
  },
};

export default musicPlaylistsProvider;
