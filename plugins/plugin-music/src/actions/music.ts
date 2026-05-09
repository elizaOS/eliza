import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  JsonValue,
  Memory,
  State,
} from "@elizaos/core";
import { isPlaybackTransportControlOnlyMessage } from "../utils/playbackTransportIntent";
import { mergedOptions } from "./confirmation";
import { manageRouting } from "./manageRouting";
import { manageZones } from "./manageZones";
import {
  inferMusicLibraryOp,
  MUSIC_LIBRARY_OP_ALIASES,
  musicLibraryAction,
} from "./musicLibrary";
import { playAudio } from "./playAudio";
import {
  inferOpFromText,
  normalizeOp,
  playbackOp,
  validatePlaybackControl,
} from "./playbackOp";

function jsonHandlerOptions(
  record: Record<string, unknown>,
): Record<string, JsonValue | undefined> {
  return record as Record<string, JsonValue | undefined>;
}

/** Library-backed ops (same contract as legacy MUSIC_LIBRARY). */
type MusicLibraryOp = "playlist" | "play_query" | "search_youtube" | "download";

type UnifiedKind = "library" | "playback" | "play_audio" | "routing" | "zones";

const PLAYER_CONTROL_OPS = new Set([
  "pause",
  "resume",
  "skip",
  "stop",
  "queue",
]);

const ROUTING_TOKENS = new Set(["routing", "manage_routing", "route_audio"]);

const ZONE_TOKENS = new Set(["zones", "manage_zones"]);

const PLAY_AUDIO_TOKENS = new Set(["play_audio", "stream", "play_music_audio"]);

function normalizeToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return normalized.length > 0 ? normalized : null;
}

function normalizeMusicLibraryOpToken(value: string): MusicLibraryOp | null {
  const n = normalizeToken(value);
  if (!n) return null;
  const direct: MusicLibraryOp[] = [
    "playlist",
    "play_query",
    "search_youtube",
    "download",
  ];
  if ((direct as readonly string[]).includes(n)) {
    return n as MusicLibraryOp;
  }
  return MUSIC_LIBRARY_OP_ALIASES[n] ?? null;
}

function tokenToUnifiedKind(token: string): UnifiedKind | null {
  const n = normalizeToken(token);
  if (!n) return null;
  if (PLAYER_CONTROL_OPS.has(n)) return "playback";
  if (ROUTING_TOKENS.has(n)) return "routing";
  if (ZONE_TOKENS.has(n)) return "zones";
  if (PLAY_AUDIO_TOKENS.has(n)) return "play_audio";
  if (normalizeMusicLibraryOpToken(n)) return "library";
  return null;
}

function readExplicitUnifiedKind(
  merged: Record<string, unknown>,
): UnifiedKind | null {
  const keys = ["op", "action", "music_op", "command"] as const;
  for (const k of keys) {
    const raw = merged[k];
    if (typeof raw !== "string") continue;
    const kind = tokenToUnifiedKind(raw);
    if (kind) return kind;
  }
  return null;
}

function ensurePlaybackMerged(
  merged: Record<string, unknown>,
  message: Memory,
): Record<string, unknown> {
  const out = { ...merged };
  const op =
    normalizeOp(out.op) ??
    normalizeOp(out.playback_op) ??
    normalizeOp(out.action);
  const resolved = op ?? inferOpFromText(message.content?.text ?? "");
  if (resolved) {
    out.op = resolved;
  }
  return out;
}

async function inferUnifiedKind(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  merged: Record<string, unknown>,
): Promise<UnifiedKind | null> {
  const explicit = readExplicitUnifiedKind(merged);
  if (explicit) return explicit;

  const text = message.content?.text ?? "";

  if (isPlaybackTransportControlOnlyMessage(text)) {
    return "playback";
  }

  if (inferOpFromText(text)) {
    return "playback";
  }

  const playState = (state ?? {}) as State;
  if (await playAudio.validate(runtime, message, playState)) {
    return "play_audio";
  }

  if (await validatePlaybackControl(runtime, message, state, merged)) {
    return "playback";
  }

  if (
    runtime.getService("musicLibrary") &&
    (await inferMusicLibraryOp(runtime, message, state, merged))
  ) {
    return "library";
  }

  if (
    await manageRouting.validate(
      runtime,
      message,
      state,
      jsonHandlerOptions(merged),
    )
  ) {
    return "routing";
  }

  if (
    await manageZones.validate(
      runtime,
      message,
      state,
      jsonHandlerOptions(merged),
    )
  ) {
    return "zones";
  }

  return null;
}

const MUSIC_CONTEXTS = [
  "media",
  "automation",
  "knowledge",
  "web",
  "files",
  "settings",
] as const;

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

const musicExamples: ActionExample[][] = [
  ...(musicLibraryAction.examples ?? []),
  ...(playbackOp.examples ?? []),
  ...(playAudio.examples ?? []),
  ...(manageRouting.examples ?? []),
  ...((manageZones as Partial<Action>).examples ?? []),
];

export const musicAction: Action = {
  name: "MUSIC",
  contexts: [...MUSIC_CONTEXTS],
  contextGate: { anyOf: [...MUSIC_CONTEXTS] },
  roleGate: { minRole: "USER" },
  similes: [
    ...(musicLibraryAction.similes ?? []),
    ...(playbackOp.similes ?? []),
    ...(playAudio.similes ?? []),
    ...(manageRouting.similes ?? []),
    ...(manageZones.similes ?? []),
  ],
  description:
    "Unified music action. Use flat op for everything: library (playlist, play_query, search_youtube, download), playback transport (pause, resume, skip, stop, queue), play_audio, routing, zones. " +
    "Transport skip/stop/queue and library mutations require confirmed:true where the underlying operation requires it.",
  descriptionCompressed:
    "Flat op: playlist/play_query/search_youtube/download/pause/resume/skip/stop/queue/play_audio/routing/zones.",
  parameters: [
    {
      name: "op",
      description:
        "Flat operation: playlist | play_query | search_youtube | download | pause | resume | skip | stop | queue | play_audio | routing | zones (hyphens and legacy aliases accepted).",
      required: false,
      schema: {
        type: "string",
        enum: [
          "playlist",
          "play_query",
          "search_youtube",
          "download",
          "pause",
          "resume",
          "skip",
          "stop",
          "queue",
          "play_audio",
          "routing",
          "zones",
        ],
      },
    },
    {
      name: "subaction",
      description:
        "Playlist subaction when op=playlist (save, load, delete, add, …).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "query",
      description: "Search/play/queue query depending on op.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "url",
      description: "Direct media URL when using play_audio.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "playlistName",
      description: "Playlist name for playlist ops.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "song",
      description: "Song query for playlist add.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "limit",
      description: "Search result limit (YouTube / library helpers).",
      required: false,
      schema: { type: "number", minimum: 1, maximum: 10 },
    },
    {
      name: "confirmed",
      description:
        "Must be true when the underlying operation requires confirmation.",
      required: false,
      schema: { type: "boolean", default: false },
    },
    {
      name: "operation",
      description:
        "Structured routing operation when using routing (set_mode, start_route, …).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "mode",
      description: "Routing mode for routing operations.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "sourceId",
      description: "Stream/source id for routing.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "targetIds",
      description: "Routing target ids.",
      required: false,
      schema: { type: "array", items: { type: "string" } },
    },
  ],
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: Record<string, unknown>,
  ): Promise<boolean> => {
    const merged = mergedOptions(options);
    const kind = await inferUnifiedKind(runtime, message, state, merged);
    if (kind) return true;
    return selectedContextMatches(state, MUSIC_CONTEXTS);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const merged = mergedOptions(options);
    const kind = await inferUnifiedKind(runtime, message, state, merged);

    if (!kind) {
      const text =
        "Could not classify a music operation. Set op to one of: playlist, play_query, search_youtube, download, pause, resume, skip, stop, queue, play_audio, routing, or zones.";
      if (callback) {
        await callback({ text, source: message.content.source });
      }
      return { success: false, text, error: text };
    }

    switch (kind) {
      case "playback": {
        const dispatchMerged = ensurePlaybackMerged(merged, message);
        return playbackOp.handler(
          runtime,
          message,
          state,
          jsonHandlerOptions(dispatchMerged),
          callback,
        );
      }
      case "play_audio": {
        if (!callback) {
          return { success: false, error: "Missing callback", text: "" };
        }
        return playAudio.handler(
          runtime,
          message,
          state as State,
          jsonHandlerOptions(merged),
          callback,
        );
      }
      case "library":
        return musicLibraryAction.handler(
          runtime,
          message,
          state,
          jsonHandlerOptions(merged),
          callback,
        );
      case "routing":
        return manageRouting.handler(
          runtime,
          message,
          state,
          jsonHandlerOptions(merged),
          callback,
        );
      case "zones":
        return manageZones.handler(
          runtime,
          message,
          state,
          jsonHandlerOptions(merged),
          callback,
        );
      default:
        return { success: false, error: "Unreachable", text: "" };
    }
  },
  examples: musicExamples,
};

export default musicAction;
