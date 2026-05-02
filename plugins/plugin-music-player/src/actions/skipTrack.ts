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

export const skipTrack: Action = {
  name: "SKIP_TRACK",
  similes: ["SKIP", "NEXT_TRACK", "SKIP_SONG", "NEXT_SONG"],
  description:
    "Skip the current track and play the next queued song. Use for skip, next track, or next song. " +
    "Requires confirmed:true. Never use PLAY_AUDIO for skip — use SKIP_TRACK.",
  descriptionCompressed: "Skip to next queued song. Not via PLAY_AUDIO.",
  parameters: [
    {
      name: "confirmed",
      description: "Must be true to skip the current track.",
      required: false,
      schema: { type: "boolean", default: false },
    },
  ],
  validate: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    const musicService = runtime.getService(
      MUSIC_SERVICE_NAME,
    ) as unknown as MusicService;
    if (!musicService) return false;
    // Allow from any source — find any active guild
    const queues = musicService.getQueues();
    for (const [guildId] of queues) {
      if (musicService.getCurrentTrack(guildId)) return true;
    }
    return false;
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

    const currentTrack = musicService.getCurrentTrack(guildId);
    if (!currentTrack) {
      await callback({
        text: "No track is currently playing.",
        source: message.content.source,
      });
      return { success: false, error: "No current track" };
    }

    const preview = `Confirmation required before skipping **${currentTrack.title}**.`;
    if (!isConfirmed(options)) {
      await callback({
        text: preview,
        source: message.content.source,
      });
      return confirmationRequired(preview, {
        guildId,
        currentTrack: currentTrack.title,
      });
    }

    const skipped = await musicService.skip(guildId, message.entityId);
    if (skipped && currentTrack) {
      const nextTrack = musicService.getCurrentTrack(guildId);
      let text: string;
      if (nextTrack) {
        text = `Skipped **${currentTrack.title}**. Now playing: **${nextTrack.title}**`;
      } else {
        text = `Skipped **${currentTrack.title}**. Queue is now empty.`;
      }
      await callback({ text, source: message.content.source });
      return { success: true, text };
    } else {
      await callback({
        text: "Failed to skip track.",
        source: message.content.source,
      });
      return { success: false, error: "Skip failed" };
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "skip" },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Skipping to the next track!",
          actions: ["SKIP_TRACK"],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;

export default skipTrack;
