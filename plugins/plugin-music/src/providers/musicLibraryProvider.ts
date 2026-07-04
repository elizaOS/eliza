/**
 * Music library provider for aggregate library stats and recent-track context.
 *
 * It injects play counts, top tracks, and recent tracks from the persisted music
 * library into media and knowledge turns.
 */
import {
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
} from "@elizaos/core";
import {
  getLibraryStats,
  getMostPlayedSongs,
  getRecentSongs,
} from "../components/musicLibrary";

export const musicLibraryProvider: Provider = {
  name: "MUSIC_LIBRARY",
  contexts: ["media", "knowledge"],
  contextGate: { anyOf: ["media", "knowledge"] },
  cacheStable: false,
  cacheScope: "turn",
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    try {
      const stats = await getLibraryStats(runtime);
      const mostPlayed = await getMostPlayedSongs(runtime, 20);
      const recentSongs = await getRecentSongs(runtime, 10);

      return {
        text: JSON.stringify(
          {
            music_library: {
              total_tracks: stats.totalSongs,
              total_plays: stats.totalPlays,
              most_played: stats.mostPlayed ?? null,
              top_tracks: mostPlayed.map((song, index) => ({
                rank: index + 1,
                title: song.title,
                artist: song.artist || song.channel || "Unknown Artist",
                play_count: song.playCount,
                duration: song.duration,
              })),
              recent_tracks: recentSongs.map((song, index) => ({
                rank: index + 1,
                title: song.title,
                artist: song.artist || song.channel || "Unknown Artist",
                play_count: song.playCount,
                last_played: formatTimeAgo(Date.now() - song.lastPlayed),
              })),
              note:
                stats.totalSongs === 0
                  ? "Library is empty. Tracks are added as they are played."
                  : 'References like "it", "that", or "this song" usually mean the most recent track.',
            },
          },
          null,
          2,
        ),
      };
    } catch (error) {
      logger.error(
        "Error in music library provider:",
        error instanceof Error ? error.message : String(error),
      );
      return { text: "" };
    }
  },
};

// Formats a millisecond delta into compact provider text.
function formatTimeAgo(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days} day${days > 1 ? "s" : ""} ago`;
  }
  if (hours > 0) {
    return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  }
  if (minutes > 0) {
    return `${minutes} minute${minutes > 1 ? "s" : ""} ago`;
  }
  return "just now";
}

export default musicLibraryProvider;
