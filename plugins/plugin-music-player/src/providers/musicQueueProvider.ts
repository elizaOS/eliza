import {
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
} from "@elizaos/core";
import type { MusicService } from "../service";

const MUSIC_SERVICE_NAME = "music";
const DEFAULT_LIMIT = 25;

const formatDuration = (seconds?: number): string => {
  if (!seconds) return "Unknown";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
};

export const musicQueueProvider: Provider = {
  name: "musicQueue",
  description: "Current music queue and now-playing track.",
  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
  ): Promise<ProviderResult> => {
    try {
      const musicService = runtime.getService(
        MUSIC_SERVICE_NAME,
      ) as unknown as MusicService | null;
      if (!musicService) return { text: "" };

      const room = state?.data?.room || (await runtime.getRoom(message.roomId));
      const currentServerId = room?.serverId;
      if (!currentServerId) return { text: "" };

      const currentTrack = musicService.getCurrentTrack(currentServerId);
      const queue = musicService.getQueueList(currentServerId);

      if (!currentTrack && queue.length === 0) {
        return {
          text: JSON.stringify(
            {
              music_queue: { now_playing: null, count: 0, items: [] },
            },
            null,
            2,
          ),
        };
      }

      const items = queue.slice(0, DEFAULT_LIMIT).map((track, index) => ({
        position: index + 1,
        title: track.title,
        duration: formatDuration(track.duration),
      }));

      return {
        text: JSON.stringify(
          {
            music_queue: {
              now_playing: currentTrack
                ? {
                    title: currentTrack.title,
                    duration: formatDuration(currentTrack.duration),
                  }
                : null,
              count: queue.length,
              items,
              truncated: queue.length > DEFAULT_LIMIT,
            },
          },
          null,
          2,
        ),
      };
    } catch (error) {
      logger.error(
        "Error in musicQueue provider:",
        error instanceof Error ? error.message : String(error),
      );
      return { text: "" };
    }
  },
};

export default musicQueueProvider;
