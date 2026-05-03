import type {
  Action,
  ActionExample,
  Content,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { emitRetakeEvent } from "./chat-api.ts";
import { LOCAL_API_PORT } from "./constants.ts";
import { VALID_EMOTE_IDS } from "./emotes.ts";
import { cachedAccessToken, seenViewers, setInitialPollDone } from "./state.ts";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function getRetakeAuth(_runtime: IAgentRuntime) {
  return { accessToken: cachedAccessToken };
}

// ---------------------------------------------------------------------------
// START_RETAKE_STREAM
// ---------------------------------------------------------------------------

export const startRetakeStreamAction: Action = {
  name: "START_RETAKE_STREAM",
  description:
    "Start streaming to retake.tv. Initiates the RTMP pipeline with browser capture.",
  similes: [
    "GO_LIVE",
    "START_STREAMING",
    "BEGIN_STREAM",
    "START_RETAKE",
    "GO_LIVE_RETAKE",
  ],
  parameters: [],

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const { accessToken } = getRetakeAuth(runtime);
    return !!accessToken;
  },

  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ) => {
    // Reset viewer tracking for the new stream session
    seenViewers.clear();
    setInitialPollDone(false);

    try {
      const res = await fetch(
        `http://127.0.0.1:${LOCAL_API_PORT}/api/stream/live`,
        { method: "POST", signal: AbortSignal.timeout(30_000) },
      );
      const data = (await res.json()) as Record<string, unknown>;
      if (callback) {
        await callback({
          text: data.live
            ? "Stream is now live on retake.tv!"
            : `Stream start response: ${JSON.stringify(data)}`,
          actions: [],
        } as Content);
      }
      return { success: !!data.ok };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (callback) {
        await callback({
          text: `Failed to start stream: ${msg}`,
          actions: [],
        } as Content);
      }
      return { success: false };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Go live on retake" },
      } as ActionExample,
      {
        name: "{{agent}}",
        content: {
          text: "Starting the stream now.",
          actions: ["START_RETAKE_STREAM"],
        },
      } as ActionExample,
    ],
  ],
};

// ---------------------------------------------------------------------------
// STOP_RETAKE_STREAM
// ---------------------------------------------------------------------------

export const stopRetakeStreamAction: Action = {
  name: "STOP_RETAKE_STREAM",
  description:
    "Stop the active retake.tv stream. Shuts down FFmpeg and notifies retake.tv.",
  similes: [
    "GO_OFFLINE",
    "STOP_STREAMING",
    "END_STREAM",
    "STOP_RETAKE",
    "GO_OFFLINE_RETAKE",
  ],
  parameters: [],

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const { accessToken } = getRetakeAuth(runtime);
    return !!accessToken;
  },

  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ) => {
    try {
      const res = await fetch(
        `http://127.0.0.1:${LOCAL_API_PORT}/api/stream/offline`,
        { method: "POST", signal: AbortSignal.timeout(15_000) },
      );
      const data = (await res.json()) as Record<string, unknown>;
      if (callback) {
        await callback({
          text: "Stream stopped. You're now offline on retake.tv.",
          actions: [],
        } as Content);
      }
      return { success: !!data.ok };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (callback) {
        await callback({
          text: `Failed to stop stream: ${msg}`,
          actions: [],
        } as Content);
      }
      return { success: false };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Stop the retake stream" },
      } as ActionExample,
      {
        name: "{{agent}}",
        content: {
          text: "Stopping the stream.",
          actions: ["STOP_RETAKE_STREAM"],
        },
      } as ActionExample,
    ],
  ],
};

// ---------------------------------------------------------------------------
// GET_RETAKE_STREAM_STATUS
// ---------------------------------------------------------------------------

export const getRetakeStreamStatusAction: Action = {
  name: "GET_RETAKE_STREAM_STATUS",
  description:
    "Check the current status and health of the retake.tv stream (running, uptime, frame count, etc).",
  similes: [
    "STREAM_STATUS",
    "CHECK_STREAM",
    "RETAKE_STATUS",
    "IS_STREAM_LIVE",
    "STREAM_HEALTH",
  ],
  parameters: [],

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const { accessToken } = getRetakeAuth(runtime);
    return !!accessToken;
  },

  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ) => {
    try {
      const res = await fetch(
        `http://127.0.0.1:${LOCAL_API_PORT}/api/stream/status`,
        { signal: AbortSignal.timeout(10_000) },
      );
      const data = (await res.json()) as Record<string, unknown>;
      const status = data.running ? "LIVE" : "OFFLINE";
      if (callback) {
        await callback({
          text: `Stream is ${status}. Uptime: ${data.uptime ?? 0}s, Frames: ${data.frameCount ?? 0}, FFmpeg: ${data.ffmpegAlive ? "alive" : "dead"}, Volume: ${data.volume}${data.muted ? " (muted)" : ""}.`,
          actions: [],
        } as Content);
      }
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (callback) {
        await callback({
          text: `Failed to get stream status: ${msg}`,
          actions: [],
        } as Content);
      }
      return { success: false };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Is the retake stream running?" },
      } as ActionExample,
      {
        name: "{{agent}}",
        content: {
          text: "Let me check the stream status.",
          actions: ["GET_RETAKE_STREAM_STATUS"],
        },
      } as ActionExample,
    ],
  ],
};

// ---------------------------------------------------------------------------
// PLAY_EMOTE
// ---------------------------------------------------------------------------

export const playEmoteAction: Action = {
  name: "PLAY_EMOTE",
  description: `Play an emote animation on your avatar. Available emotes: ${VALID_EMOTE_IDS.join(", ")}. Use emotes to express yourself visually on stream — react to chat, celebrate, dance, etc.`,
  similes: [
    "DO_EMOTE",
    "EMOTE",
    "AVATAR_EMOTE",
    "PLAY_ANIMATION",
    "DANCE",
    "WAVE",
  ],
  parameters: [],

  validate: async (): Promise<boolean> => true,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ) => {
    // Extract emote ID from message text
    const text = (message.content?.text ?? "").toLowerCase();
    let emoteId = "";

    // Try to match against known emote IDs
    for (const id of VALID_EMOTE_IDS) {
      if (text.includes(id.replace("-", " ")) || text.includes(id)) {
        emoteId = id;
        break;
      }
    }

    // Fallback heuristics
    if (!emoteId) {
      if (
        text.includes("wave") ||
        text.includes("greet") ||
        text.includes("hello")
      )
        emoteId = "wave";
      else if (text.includes("dance") || text.includes("vibe"))
        emoteId = "dance-happy";
      else if (text.includes("cry") || text.includes("sad")) emoteId = "crying";
      else if (text.includes("flip") || text.includes("backflip"))
        emoteId = "flip";
      else if (text.includes("jump")) emoteId = "jump";
      else if (text.includes("punch") || text.includes("fight"))
        emoteId = "punching";
      else if (text.includes("fish")) emoteId = "fishing";
      else emoteId = "wave"; // safe default
    }

    try {
      const res = await fetch(`http://127.0.0.1:${LOCAL_API_PORT}/api/emote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emoteId }),
        signal: AbortSignal.timeout(15_000),
      });
      const data = (await res.json()) as Record<string, unknown>;
      if (callback) {
        await callback({
          text: `*does a ${emoteId.replace("-", " ")} emote*`,
          actions: [],
        } as Content);
      }

      // Also emit as an event so it appears in the stream activity
      emitRetakeEvent(runtime, "action", {
        text: `Playing emote: ${emoteId}`,
        emoteId,
        channel: "avatar",
      });

      return { success: !!data.ok };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (callback) {
        await callback({
          text: `Failed to play emote: ${msg}`,
          actions: [],
        } as Content);
      }
      return { success: false };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "do a dance",
          source: "retake",
          channelType: "GROUP",
        },
      } as ActionExample,
      {
        name: "{{agent}}",
        content: {
          text: "bet, watch this",
          actions: ["PLAY_EMOTE"],
        },
      } as ActionExample,
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "wave to the chat" },
      } as ActionExample,
      {
        name: "{{agent}}",
        content: {
          text: "hey everyone~",
          actions: ["PLAY_EMOTE"],
        },
      } as ActionExample,
    ],
  ],
};
