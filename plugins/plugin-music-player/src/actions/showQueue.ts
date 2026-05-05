import type {
  Action,
  ActionExample,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { MusicService } from "../service";

const MUSIC_SERVICE_NAME = "music";

const formatDuration = (seconds?: number): string => {
  if (!seconds) return "Unknown";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
};

function readLimit(options: unknown): number {
  const direct =
    options && typeof options === "object"
      ? (options as Record<string, unknown>)
      : {};
  const params =
    direct.parameters && typeof direct.parameters === "object"
      ? (direct.parameters as Record<string, unknown>)
      : {};
  const raw = params.limit ?? direct.limit;
  const parsed =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number.parseInt(raw, 10)
        : 10;
  if (!Number.isFinite(parsed)) return 10;
  return Math.min(Math.max(1, Math.floor(parsed)), 25);
}

export const showQueue: Action = {
  name: "SHOW_QUEUE",
  similes: ["QUEUE", "LIST_QUEUE", "SHOW_PLAYLIST", "QUEUE_LIST"],
  description: "Show the current music queue",
  descriptionCompressed: "show current music queue",
  parameters: [
    {
      name: "limit",
      description: "Maximum queued tracks to display, from 1 to 25.",
      required: false,
      schema: { type: "number", minimum: 1, maximum: 25, default: 10 },
    },
  ],
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    if (message.content.source !== "discord") {
      return false;
    }
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options: any,
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
    const currentServerId = room?.serverId;

    if (!currentServerId) {
      await callback({
        text: "I could not determine which server you are in.",
        source: message.content.source,
      });
      return;
    }

    const currentTrack = musicService.getCurrentTrack(currentServerId);
    const queue = musicService.getQueueList(currentServerId);

    if (!currentTrack && queue.length === 0) {
      await callback({
        text: "The queue is empty.",
        source: message.content.source,
      });
      return;
    }

    let text = "";
    if (currentTrack) {
      text += `**Now Playing:** ${currentTrack.title} (${formatDuration(currentTrack.duration)})\n\n`;
    }

    const limit = readLimit(options);

    if (queue.length > 0) {
      text += `**Queue (${queue.length}):**\n`;
      queue.slice(0, limit).forEach((track, index) => {
        text += `${index + 1}. ${track.title} (${formatDuration(track.duration)})\n`;
      });
      if (queue.length > limit) {
        text += `\n... and ${queue.length - limit} more`;
      }
    } else {
      text += "Queue is empty.";
    }

    await callback({
      text,
      source: message.content.source,
    });
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "show queue" },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Here is the current queue:",
          actions: ["SHOW_QUEUE"],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;

export default showQueue;
