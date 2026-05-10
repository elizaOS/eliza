import {
  type Action,
  type ActionExample,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import { MusicService } from "../service";
import {
  type FetchProgress,
  SmartMusicFetchService,
} from "../services/smartMusicFetch";
import { classifyPlaybackTransportIntent } from "../utils/playbackTransportIntent";
import { ProgressiveMessage } from "../utils/progressiveMessage";
import { resolveMusicGuildIdForPlayback } from "../utils/resolveMusicGuildId";
import {
  confirmationRequired,
  isConfirmed,
  mergedOptions,
} from "./confirmation";

function formatFetchProgressDetails(details: unknown): string | undefined {
  if (details === undefined) return undefined;
  if (typeof details === "string") return details;
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

const MUSIC_SERVICE_NAME = "music";
const PLAYBACK_CONTEXTS = ["media", "automation"] as const;
const PLAYBACK_KEYWORDS = [
  "pause",
  "resume",
  "unpause",
  "skip",
  "next",
  "stop",
  "queue",
  "playback",
  "music",
  "audio",
  "pausa",
  "reanudar",
  "saltar",
  "detener",
  "cola",
  "reprendre",
  "arrêter",
  "suivant",
  "warteschlange",
  "pausieren",
  "fortsetzen",
  "überspringen",
  "停止",
  "一時停止",
  "再開",
  "スキップ",
  "暂停",
  "继续",
  "跳过",
  "停止",
  "일시정지",
  "재개",
  "건너뛰기",
  "중지",
] as const;

export type PlaybackControlOp = "pause" | "resume" | "skip" | "stop" | "queue";

type PlaybackOp = PlaybackControlOp;
type ActionResultData = NonNullable<ActionResult["data"]>;

function failureResult(
  text: string,
  error: string,
  data?: ActionResultData,
): ActionResult {
  return { success: false, text, error, data };
}

function selectedContextMatches(
  state: State | undefined,
  contexts: readonly string[],
): boolean {
  const selected = new Set<string>();
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === "string") selected.add(item);
    }
  };
  collect(
    (state?.values as Record<string, unknown> | undefined)?.selectedContexts,
  );
  collect(
    (state?.data as Record<string, unknown> | undefined)?.selectedContexts,
  );
  const contextObject = (state?.data as Record<string, unknown> | undefined)
    ?.contextObject as
    | {
        trajectoryPrefix?: { selectedContexts?: unknown };
        metadata?: { selectedContexts?: unknown };
      }
    | undefined;
  collect(contextObject?.trajectoryPrefix?.selectedContexts);
  collect(contextObject?.metadata?.selectedContexts);
  return contexts.some((context) => selected.has(context));
}

function hasPlaybackIntent(message: Memory, state: State | undefined): boolean {
  const text = [
    typeof message.content?.text === "string" ? message.content.text : "",
    typeof state?.values?.recentMessages === "string"
      ? state.values.recentMessages
      : "",
  ]
    .join("\n")
    .toLowerCase();
  return PLAYBACK_KEYWORDS.some((keyword) =>
    text.includes(keyword.toLowerCase()),
  );
}

function normalizeOp(value: unknown): PlaybackOp | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (
    v === "pause" ||
    v === "resume" ||
    v === "skip" ||
    v === "stop" ||
    v === "queue"
  ) {
    return v;
  }
  return null;
}

function inferOpFromText(text: string): PlaybackOp | null {
  const transport = classifyPlaybackTransportIntent(text);
  if (transport) return transport;
  const lower = (text || "").toLowerCase();
  if (/\b(queue|add\s+to\s+queue)\b/.test(lower)) return "queue";
  return null;
}

function findActiveGuildId(musicService: MusicService): string | null {
  const queues = musicService.getQueues();
  for (const [guildId] of queues) {
    if (musicService.getCurrentTrack(guildId)) return guildId;
  }
  return null;
}

/** Supports optional `options` so callers can pass explicit `op` without message text. */
export async function validatePlaybackControl(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options?: Record<string, unknown>,
): Promise<boolean> {
  const merged = mergedOptions(options);
  const explicit = normalizeOp(merged.op);
  const text = message.content?.text ?? "";
  const inferredFromText = inferOpFromText(text);
  const inferred = explicit ?? inferredFromText;
  if (
    !inferred &&
    !(
      selectedContextMatches(state, PLAYBACK_CONTEXTS) ||
      hasPlaybackIntent(message, state)
    )
  ) {
    return false;
  }
  if (!inferred) return true;
  const musicService = runtime.getService(MUSIC_SERVICE_NAME) as MusicService;
  if (!musicService) return inferred === "queue";
  if (inferred === "queue") return true;
  if (inferred === "pause") {
    const guildId = findActiveGuildId(musicService);
    if (!guildId) return false;
    return (
      musicService.getIsPlaying(guildId) && !musicService.getIsPaused(guildId)
    );
  }
  if (inferred === "resume") {
    const guildId = findActiveGuildId(musicService);
    if (!guildId) return false;
    return musicService.getIsPaused(guildId);
  }
  return findActiveGuildId(musicService) !== null;
}

export { inferOpFromText, normalizeOp };

async function handlePause(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  callback: HandlerCallback,
): Promise<ActionResult> {
  const musicService = runtime.getService(MUSIC_SERVICE_NAME) as MusicService;
  if (!musicService) {
    await callback({
      text: "Music service is not available.",
      source: message.content.source,
    });
    return failureResult(
      "Music service unavailable",
      "Music service unavailable",
    );
  }

  const room = state?.data?.room || (await runtime.getRoom(message.roomId));
  const guildId = resolveMusicGuildIdForPlayback(message, room, musicService);
  if (!guildId) {
    const text = "Nothing is playing right now.";
    await callback({ text, source: message.content.source });
    return failureResult("Nothing playing", "Nothing playing");
  }

  const track = musicService.getCurrentTrack(guildId);
  await musicService.pause(guildId);

  const text = track
    ? `Paused **${track.title}**. Say "resume" to continue.`
    : "Playback paused.";
  await callback({ text, source: message.content.source });
  return { success: true, text };
}

async function handleResume(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  callback: HandlerCallback,
): Promise<ActionResult> {
  const musicService = runtime.getService(MUSIC_SERVICE_NAME) as MusicService;
  if (!musicService) {
    await callback({
      text: "Music service is not available.",
      source: message.content.source,
    });
    return failureResult(
      "Music service unavailable",
      "Music service unavailable",
    );
  }

  const room = state?.data?.room || (await runtime.getRoom(message.roomId));
  const guildId = resolveMusicGuildIdForPlayback(message, room, musicService);
  if (!guildId) {
    const text = "Nothing is paused right now.";
    await callback({ text, source: message.content.source });
    return failureResult("Nothing paused", "Nothing paused");
  }

  const track = musicService.getCurrentTrack(guildId);
  await musicService.resume(guildId);
  const text = track ? `Resumed **${track.title}**.` : "Playback resumed.";
  await callback({ text, source: message.content.source });
  return { success: true, text };
}

async function handleSkip(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: Record<string, unknown>,
  callback: HandlerCallback,
): Promise<ActionResult> {
  const musicService = runtime.getService(MUSIC_SERVICE_NAME) as MusicService;
  if (!musicService) {
    await callback({
      text: "Music service is not available.",
      source: message.content.source,
    });
    return failureResult(
      "Music service unavailable",
      "Music service unavailable",
    );
  }

  const room = state?.data?.room || (await runtime.getRoom(message.roomId));
  const guildId = resolveMusicGuildIdForPlayback(message, room, musicService);
  if (!guildId) {
    const text = "Nothing is playing right now.";
    await callback({ text, source: message.content.source });
    return failureResult("Nothing playing", "Nothing playing");
  }

  const currentTrack = musicService.getCurrentTrack(guildId);
  if (!currentTrack) {
    const text = "No track is currently playing.";
    await callback({ text, source: message.content.source });
    return failureResult("No current track", "No current track");
  }

  const preview = `Confirmation required before skipping **${currentTrack.title}**.`;
  if (!isConfirmed(options)) {
    await callback({ text: preview, source: message.content.source });
    return confirmationRequired(preview, {
      op: "skip",
      guildId,
      currentTrack: currentTrack.title,
    });
  }

  const skipped = await musicService.skip(guildId, message.entityId);
  if (!skipped) {
    const text = "Failed to skip track.";
    await callback({ text, source: message.content.source });
    return failureResult("Skip failed", "Skip failed");
  }

  const nextTrack = musicService.getCurrentTrack(guildId);
  const text = nextTrack
    ? `Skipped **${currentTrack.title}**. Now playing: **${nextTrack.title}**`
    : `Skipped **${currentTrack.title}**. Queue is now empty.`;
  await callback({ text, source: message.content.source });
  return { success: true, text };
}

async function handleStop(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: Record<string, unknown>,
  callback: HandlerCallback,
): Promise<ActionResult> {
  const musicService = runtime.getService(MUSIC_SERVICE_NAME) as MusicService;
  if (!musicService) {
    await callback({
      text: "Music service is not available.",
      source: message.content.source,
    });
    return failureResult(
      "Music service unavailable",
      "Music service unavailable",
    );
  }

  const room = state?.data?.room || (await runtime.getRoom(message.roomId));
  const guildId = resolveMusicGuildIdForPlayback(message, room, musicService);
  if (!guildId) {
    const text = "Nothing is playing right now.";
    await callback({ text, source: message.content.source });
    return failureResult("Nothing playing", "Nothing playing");
  }

  const track = musicService.getCurrentTrack(guildId);
  const queueLength = musicService.getQueueList(guildId).length;
  const preview = track
    ? `Confirmation required before stopping **${track.title}** and clearing ${queueLength} queued track${queueLength !== 1 ? "s" : ""}.`
    : "Confirmation required before stopping playback and clearing the queue.";
  if (!isConfirmed(options)) {
    await callback({ text: preview, source: message.content.source });
    return confirmationRequired(preview, {
      op: "stop",
      guildId,
      currentTrack: track?.title ?? null,
      queueLength,
    });
  }

  await musicService.stopPlayback(guildId);
  musicService.clear(guildId);

  const text = track
    ? `Stopped playing **${track.title}** and cleared the queue.`
    : "Playback stopped.";
  await callback({ text, source: message.content.source });
  return { success: true, text };
}

async function handleQueue(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: Record<string, unknown>,
  callback: HandlerCallback,
): Promise<ActionResult> {
  const messageText = message.content.text || "";
  const directQuery =
    typeof options.query === "string" && options.query.trim().length > 0
      ? options.query.trim()
      : undefined;
  const query = (directQuery || messageText).trim();
  if (!query || query.length < 3) {
    const text =
      "Please tell me what song you'd like to queue (at least 3 characters).";
    await callback({ text, source: message.content.source || "discord" });
    return failureResult(text, "Missing queue query");
  }

  const preview = `Confirmation required before adding "${query}" to the music queue.`;
  if (!isConfirmed(options)) {
    await callback({
      text: preview,
      source: message.content.source || "discord",
    });
    return confirmationRequired(preview, { op: "queue", query });
  }

  const progress = new ProgressiveMessage(
    callback,
    message.content.source || "discord",
  );
  progress.update("🔍 Looking up track...");

  const smartFetch = new SmartMusicFetchService(runtime);
  const preferredQuality =
    (runtime.getSetting("MUSIC_QUALITY_PREFERENCE") as string) || "mp3_320";

  let lastProgress = "";
  const onProgress = async (progressInfo: FetchProgress) => {
    const detailText = formatFetchProgressDetails(progressInfo.details);
    const statusText = `${progressInfo.message}${detailText ? `: ${detailText}` : ""}`;
    if (statusText !== lastProgress) {
      lastProgress = statusText;
      logger.info(`[PLAYBACK_OP queue] ${statusText}`);
      progress.update(
        `🔍 ${progressInfo.message}${detailText ? `: ${detailText}` : ""}`,
        { important: true },
      );
    }
  };

  const result = await smartFetch.fetchMusic({
    query,
    requestedBy: message.entityId,
    onProgress,
    preferredQuality: preferredQuality as "flac" | "mp3_320" | "any",
  });

  if (!result.success || !result.url) {
    await progress.fail(
      `❌ Couldn't find or download "${query}". ${result.error || "Please try a different search term."}`,
    );
    return failureResult(
      `Couldn't find or download "${query}". ${result.error || "Please try a different search term."}`,
      result.error || "Music not found",
      { op: "queue", query },
    );
  }

  progress.update("✨ Adding to queue...");

  const room = state?.data?.room || (await runtime.getRoom(message.roomId));
  let currentServerId = room?.serverId;
  if (!currentServerId) {
    currentServerId =
      message.content.source === "discord"
        ? room?.serverId || message.roomId
        : `web-${message.roomId}`;
  } else if (message.content.source !== "discord") {
    currentServerId = `web-${currentServerId}`;
  }

  const requestUserId = message.entityId;
  let musicService = runtime.getService("music") as MusicService;
  if (!musicService) musicService = new MusicService(runtime);

  const queueLength = musicService.getQueueList(currentServerId).length;
  const position = queueLength + 1;

  let sourceEmoji = "";
  if (result.source === "library") sourceEmoji = "📚";
  else if (result.source === "ytdlp") sourceEmoji = "🎬";
  else if (result.source === "torrent") sourceEmoji = "🌊";

  let responseText = `${sourceEmoji} Added to queue (position ${position}): **${query}**`;
  if (result.source === "torrent") {
    responseText += "\n_Downloaded via torrent and added to your library_";
  }

  const track = await musicService.addTrack(currentServerId, {
    url: result.url,
    title: query,
    requestedBy: requestUserId,
  });

  runtime
    .createMemory(
      {
        entityId: runtime.agentId,
        agentId: message.agentId,
        roomId: message.roomId,
        content: {
          source: "action",
          thought: `Queued music: ${query} (source: ${result.source})`,
          actions: ["PLAYBACK"],
        },
        metadata: {
          type: "custom" as const,
          kind: "PLAYBACK",
          op: "queue",
          audioUrl: result.url,
          title: query,
          trackId: track.id,
          source: result.source,
        },
      },
      "messages",
    )
    .catch((error) => logger.warn(`Failed to create memory: ${error}`));

  await progress.complete(responseText);
  return {
    success: true,
    text: responseText,
    data: {
      op: "queue",
      query,
      position,
      trackId: track.id,
      source: result.source,
      audioUrl: result.url,
    },
  };
}

export const playbackOp: Action = {
  name: "PLAYBACK",
  contexts: ["media", "automation"],
  contextGate: { anyOf: ["media", "automation"] },
  roleGate: { minRole: "USER" },
  similes: [
    "PAUSE_MUSIC",
    "RESUME_MUSIC",
    "STOP_MUSIC",
    "SKIP_TRACK",
    "QUEUE_MUSIC",
    "PAUSE",
    "RESUME",
    "UNPAUSE",
    "SKIP",
    "NEXT_TRACK",
    "ADD_TO_QUEUE",
  ],
  description:
    "Music playback control. Use op=pause, resume, skip, stop, or queue. " +
    "Use this for transport control instead of PLAY_AUDIO. " +
    "skip, stop, and queue require confirmed:true.",
  descriptionCompressed:
    "Music playback ops: pause, resume, skip, stop, queue.",
  parameters: [
    {
      name: "subaction",
      description: "Playback operation: pause, resume, skip, stop, or queue.",
      required: true,
      schema: {
        type: "string",
        enum: ["pause", "resume", "skip", "stop", "queue"],
      },
    },
    {
      name: "query",
      description: "Track query for op=queue.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "confirmed",
      description: "Must be true for skip, stop, or queue.",
      required: false,
      schema: { type: "boolean", default: false },
    },
  ],
  validate: async (
    runtime,
    message,
    state,
    options?: Record<string, unknown>,
  ) => validatePlaybackControl(runtime, message, state, options),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    if (!callback) return failureResult("Missing callback", "Missing callback");
    const merged = mergedOptions(options);
    const op =
      normalizeOp(merged.op) ?? inferOpFromText(message.content?.text ?? "");
    if (!op) {
      const text =
        "Could not determine playback op. Use op=pause, resume, skip, stop, or queue.";
      await callback({ text, source: message.content.source });
      return failureResult(text, text);
    }

    if (op === "pause") return handlePause(runtime, message, state, callback);
    if (op === "resume") return handleResume(runtime, message, state, callback);
    if (op === "skip")
      return handleSkip(runtime, message, state, merged, callback);
    if (op === "stop")
      return handleStop(runtime, message, state, merged, callback);
    return handleQueue(runtime, message, state, merged, callback);
  },
  examples: [
    [
      { name: "{{name1}}", content: { text: "pause the music" } },
      {
        name: "{{name2}}",
        content: {
          text: 'Paused the music. Say "resume" to continue.',
          actions: ["PLAYBACK"],
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "resume" } },
      {
        name: "{{name2}}",
        content: { text: "Resumed playback.", actions: ["PLAYBACK"] },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "skip" } },
      {
        name: "{{name2}}",
        content: {
          text: "Confirmation required before skipping.",
          actions: ["PLAYBACK"],
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "stop the music" } },
      {
        name: "{{name2}}",
        content: {
          text: "Confirmation required before stopping playback.",
          actions: ["PLAYBACK"],
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "queue Hotel California" } },
      {
        name: "{{name2}}",
        content: {
          text: 'Confirmation required before adding "Hotel California" to the queue.',
          actions: ["PLAYBACK"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default playbackOp;
