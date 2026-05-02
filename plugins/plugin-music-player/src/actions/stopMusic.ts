import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { MusicService } from "../service";
import { resolveMusicGuildIdForPlayback } from "../utils/resolveMusicGuildId";
import { confirmationRequired, isConfirmed } from "./confirmation";

const MUSIC_SERVICE_NAME = "music";

/**
 * Finds the first guild with an active track.
 */
function findActiveGuildId(musicService: MusicService): string | null {
  const queues = musicService.getQueues();
  for (const [guildId] of queues) {
    if (musicService.getCurrentTrack(guildId)) return guildId;
  }
  return null;
}

export const stopMusic: Action = {
  name: "STOP_MUSIC",
  similes: [
    "STOP_AUDIO",
    "STOP_PLAYING",
    "STOP_SONG",
    "TURN_OFF_MUSIC",
    "MUSIC_OFF",
    "SILENCE",
  ],
  description:
    "Stop playback and clear the queue. Use when the user wants music off or the queue cleared. " +
    "Requires confirmed:true. Never use PLAY_AUDIO for stop — use STOP_MUSIC.",
  descriptionCompressed: "Stop playback, clear queue. Not via PLAY_AUDIO.",
  parameters: [
    {
      name: "confirmed",
      description: "Must be true to stop playback and clear the queue.",
      required: false,
      schema: { type: "boolean", default: false },
    },
  ],
  validate: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    const musicService = runtime.getService(
      MUSIC_SERVICE_NAME,
    ) as unknown as MusicService;
    if (!musicService) return false;
    return findActiveGuildId(musicService) !== null;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options: Record<string, unknown> | undefined,
    callback: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const musicService = runtime.getService(
      MUSIC_SERVICE_NAME,
    ) as unknown as MusicService;
    if (!musicService) {
      await callback({
        text: "Music service is not available.",
        source: message.content.source,
      });
      return { success: false, error: "Music service unavailable" };
    }

    const room = state.data?.room || (await runtime.getRoom(message.roomId));
    const guildId = resolveMusicGuildIdForPlayback(message, room, musicService);

    if (!guildId) {
      await callback({
        text: "Nothing is playing right now.",
        source: message.content.source,
      });
      return { success: false, error: "Nothing playing" };
    }

    const track = musicService.getCurrentTrack(guildId);
    const queueLength = musicService.getQueueList(guildId).length;
    const preview = track
      ? `Confirmation required before stopping **${track.title}** and clearing ${queueLength} queued track${queueLength !== 1 ? "s" : ""}.`
      : "Confirmation required before stopping playback and clearing the queue.";
    if (!isConfirmed(options)) {
      await callback({
        text: preview,
        source: message.content.source,
      });
      return confirmationRequired(preview, {
        guildId,
        currentTrack: track?.title ?? null,
        queueLength,
      });
    }

    await musicService.stopPlayback(guildId);
    musicService.clear(guildId);

    await callback({
      text: track
        ? `Stopped playing **${track.title}** and cleared the queue.`
        : "Playback stopped.",
      source: message.content.source,
    });
    return { success: true, text: "Playback stopped." };
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "stop the music" },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Stopped the music and cleared the queue.",
          actions: ["STOP_MUSIC"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "turn off the music please" },
      },
      {
        name: "{{name2}}",
        content: { text: "Music stopped!", actions: ["STOP_MUSIC"] },
      },
    ],
  ] as ActionExample[][],
} as Action;

export default stopMusic;
