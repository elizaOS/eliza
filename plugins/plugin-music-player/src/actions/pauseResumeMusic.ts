import type {
  Action,
  ActionExample,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { MusicService } from "../service";
import { resolveMusicGuildIdForPlayback } from "../utils/resolveMusicGuildId";

const MUSIC_SERVICE_NAME = "music";

function findActiveGuildId(musicService: MusicService): string | null {
  const queues = musicService.getQueues();
  for (const [guildId] of queues) {
    if (musicService.getCurrentTrack(guildId)) return guildId;
  }
  return null;
}

export const pauseMusic: Action = {
  name: "PAUSE_MUSIC",
  similes: ["PAUSE", "PAUSE_AUDIO", "PAUSE_SONG", "PAUSE_PLAYBACK"],
  description:
    "Pause the currently playing track (hold playback). Use whenever the user asks to pause music or audio. " +
    "Never implement pause by calling PLAY_AUDIO.",
  descriptionCompressed: "Pause current track. Not via PLAY_AUDIO.",
  validate: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    const musicService = runtime.getService(
      MUSIC_SERVICE_NAME,
    ) as unknown as MusicService;
    if (!musicService) return false;
    const guildId = findActiveGuildId(musicService);
    if (!guildId) return false;
    return (
      musicService.getIsPlaying(guildId) && !musicService.getIsPaused(guildId)
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: any,
    callback: HandlerCallback,
  ) => {
    const musicService = runtime.getService(
      MUSIC_SERVICE_NAME,
    ) as unknown as MusicService;
    if (!musicService) {
      await callback({
        text: "Music service is not available.",
        source: message.content.source,
      });
      return;
    }

    const room = state.data?.room || (await runtime.getRoom(message.roomId));
    const guildId = resolveMusicGuildIdForPlayback(message, room, musicService);

    if (!guildId) {
      await callback({
        text: "Nothing is playing right now.",
        source: message.content.source,
      });
      return;
    }

    const track = musicService.getCurrentTrack(guildId);
    await musicService.pause(guildId);

    await callback({
      text: track
        ? `Paused **${track.title}**. Say "resume" to continue.`
        : "Playback paused.",
      source: message.content.source,
    });
  },
  examples: [
    [
      { name: "{{name1}}", content: { text: "pause the music" } },
      {
        name: "{{name2}}",
        content: {
          text: 'Paused the music. Say "resume" to continue.',
          actions: ["PAUSE_MUSIC"],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;

export const resumeMusic: Action = {
  name: "RESUME_MUSIC",
  similes: [
    "RESUME",
    "RESUME_AUDIO",
    "RESUME_SONG",
    "UNPAUSE",
    "UNPAUSE_MUSIC",
    "CONTINUE_MUSIC",
  ],
  description:
    "Resume music after a pause. Use when the user says resume, unpause, or continue. " +
    "Never use PLAY_AUDIO for this.",
  descriptionCompressed: "Resume paused music. Not via PLAY_AUDIO.",
  validate: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    const musicService = runtime.getService(
      MUSIC_SERVICE_NAME,
    ) as unknown as MusicService;
    if (!musicService) return false;
    const guildId = findActiveGuildId(musicService);
    if (!guildId) return false;
    return musicService.getIsPaused(guildId);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: any,
    callback: HandlerCallback,
  ) => {
    const musicService = runtime.getService(
      MUSIC_SERVICE_NAME,
    ) as unknown as MusicService;
    if (!musicService) {
      await callback({
        text: "Music service is not available.",
        source: message.content.source,
      });
      return;
    }

    const room = state.data?.room || (await runtime.getRoom(message.roomId));
    const guildId = resolveMusicGuildIdForPlayback(message, room, musicService);

    if (!guildId) {
      await callback({
        text: "Nothing is paused right now.",
        source: message.content.source,
      });
      return;
    }

    const track = musicService.getCurrentTrack(guildId);
    await musicService.resume(guildId);

    await callback({
      text: track ? `Resumed **${track.title}**.` : "Playback resumed.",
      source: message.content.source,
    });
  },
  examples: [
    [
      { name: "{{name1}}", content: { text: "resume the music" } },
      {
        name: "{{name2}}",
        content: { text: "Resumed playback!", actions: ["RESUME_MUSIC"] },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "unpause" } },
      {
        name: "{{name2}}",
        content: { text: "Resuming playback.", actions: ["RESUME_MUSIC"] },
      },
    ],
  ] as ActionExample[][],
} as Action;
