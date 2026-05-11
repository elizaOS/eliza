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

/**
 * Verb-shaped subactions exposed on the MUSIC umbrella.
 *
 * Each verb maps to a dispatch kind that resolves to one of the underlying
 * handlers. The dispatcher accepts legacy aliases (see {@link SUBACTION_ALIASES})
 * so cached planner outputs continue to resolve.
 */
const MUSIC_SUBACTIONS = [
  // playback transport
  "play",
  "pause",
  "resume",
  "skip",
  "stop",
  // queue
  "queue_view",
  "queue_add",
  "queue_clear",
  // library
  "playlist_play",
  "playlist_save",
  "search",
  "play_query",
  "download",
  "play_audio",
  // routing / zones
  "set_routing",
  "set_zone",
] as const;

type MusicSubaction = (typeof MUSIC_SUBACTIONS)[number];

type DispatchKind =
  | { kind: "playback"; playbackOp: "pause" | "resume" | "skip" | "stop" }
  | { kind: "queue_add" }
  | { kind: "queue_view" }
  | { kind: "queue_clear" }
  | { kind: "play_audio" }
  | { kind: "library"; libraryOp: LibraryOp; playlistOp?: PlaylistOp }
  | { kind: "routing" }
  | { kind: "zones" };

type LibraryOp = "playlist" | "play_query" | "search_youtube" | "download";
type PlaylistOp = "save" | "load";

/**
 * Legacy alias → canonical verb. Both the old MUSIC ops (e.g. `playlist`,
 * `search_youtube`, `routing`, `zones`, `queue`) and a handful of human-friendly
 * verbs are accepted so existing planner outputs keep dispatching cleanly.
 */
const SUBACTION_ALIASES: Record<string, MusicSubaction> = {
  // playback transport aliases
  unpause: "resume",
  next: "skip",
  start: "play",
  begin: "play",
  // queue aliases
  queue: "queue_add",
  add_to_queue: "queue_add",
  queue_show: "queue_view",
  show_queue: "queue_view",
  list_queue: "queue_view",
  clear_queue: "queue_clear",
  empty_queue: "queue_clear",
  // library aliases
  playlist: "playlist_play",
  play_playlist: "playlist_play",
  load_playlist: "playlist_play",
  save_playlist: "playlist_save",
  search_youtube: "search",
  youtube_search: "search",
  find: "search",
  find_song: "search",
  research: "play_query",
  research_and_play: "play_query",
  smart_play: "play_query",
  // routing / zones aliases
  routing: "set_routing",
  manage_routing: "set_routing",
  route_audio: "set_routing",
  zones: "set_zone",
  zone: "set_zone",
  manage_zones: "set_zone",
  // play_audio aliases
  stream: "play_audio",
  play_music_audio: "play_audio",
};

/** Discriminator keys accepted on input (canonical first, legacy after). */
const DISCRIMINATOR_KEYS = [
  "action",
  "op",
  "subaction",
  "music_op",
  "command",
] as const;

const MUSIC_CONTEXTS = [
  "media",
  "automation",
  "knowledge",
  "web",
  "files",
  "settings",
] as const;

const PLAYLIST_LOAD_TOKENS = new Set([
  "load",
  "play",
  "restore",
  "playlist_play",
  "playlist_load",
]);

const PLAYLIST_SAVE_TOKENS = new Set([
  "save",
  "create",
  "store",
  "playlist_save",
  "playlist_create",
]);

function normalizeToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return normalized.length > 0 ? normalized : null;
}

function isCanonicalSubaction(value: string): value is MusicSubaction {
  return (MUSIC_SUBACTIONS as readonly string[]).includes(value);
}

function normalizeSubaction(value: unknown): MusicSubaction | null {
  const token = normalizeToken(value);
  if (!token) return null;
  if (isCanonicalSubaction(token)) return token;
  if (SUBACTION_ALIASES[token]) return SUBACTION_ALIASES[token];
  // Library aliases (e.g. `play_music_query`, `add_to_playlist`) resolve via
  // the library alias map and then map to the canonical verb.
  const libraryOp = MUSIC_LIBRARY_OP_ALIASES[token];
  if (libraryOp === "playlist") return "playlist_play";
  if (libraryOp === "search_youtube") return "search";
  if (libraryOp === "play_query") return "play_query";
  if (libraryOp === "download") return "download";
  return null;
}

function readExplicitSubaction(
  merged: Record<string, unknown>,
): MusicSubaction | null {
  for (const key of DISCRIMINATOR_KEYS) {
    const resolved = normalizeSubaction(merged[key]);
    if (resolved) return resolved;
  }
  return null;
}

function resolvePlaylistOpFromOptions(
  merged: Record<string, unknown>,
  subaction: MusicSubaction,
): PlaylistOp | null {
  if (subaction === "playlist_save") return "save";
  if (subaction === "playlist_play") return "load";
  const tokens = [merged.playlistOp, merged.subaction, merged.action, merged.op]
    .map((value) => normalizeToken(value))
    .filter((value): value is string => Boolean(value));
  for (const token of tokens) {
    if (PLAYLIST_LOAD_TOKENS.has(token)) return "load";
    if (PLAYLIST_SAVE_TOKENS.has(token)) return "save";
  }
  return null;
}

function dispatchKindFor(
  subaction: MusicSubaction,
  merged: Record<string, unknown>,
): DispatchKind {
  switch (subaction) {
    case "pause":
    case "resume":
    case "skip":
    case "stop":
      return { kind: "playback", playbackOp: subaction };
    case "play":
      return { kind: "play_audio" };
    case "queue_add":
      return { kind: "queue_add" };
    case "queue_view":
      return { kind: "queue_view" };
    case "queue_clear":
      return { kind: "queue_clear" };
    case "play_audio":
      return { kind: "play_audio" };
    case "playlist_play":
      return {
        kind: "library",
        libraryOp: "playlist",
        playlistOp: "load",
      };
    case "playlist_save":
      return {
        kind: "library",
        libraryOp: "playlist",
        playlistOp: "save",
      };
    case "search":
      return { kind: "library", libraryOp: "search_youtube" };
    case "play_query":
      return { kind: "library", libraryOp: "play_query" };
    case "download":
      return { kind: "library", libraryOp: "download" };
    case "set_routing":
      return { kind: "routing" };
    case "set_zone":
      return { kind: "zones" };
    default: {
      const playlistOp = resolvePlaylistOpFromOptions(merged, subaction);
      if (playlistOp) {
        return { kind: "library", libraryOp: "playlist", playlistOp };
      }
      return { kind: "play_audio" };
    }
  }
}

async function inferSubactionFromText(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  merged: Record<string, unknown>,
): Promise<MusicSubaction | null> {
  const text = message.content?.text ?? "";

  if (isPlaybackTransportControlOnlyMessage(text)) {
    const playbackInferred = inferOpFromText(text);
    if (playbackInferred === "queue") return "queue_add";
    if (playbackInferred) return playbackInferred;
  }

  const transportInferred = inferOpFromText(text);
  if (transportInferred) {
    return transportInferred === "queue" ? "queue_add" : transportInferred;
  }

  const playState = (state ?? {}) as State;
  if (await playAudio.validate(runtime, message, playState)) {
    return "play_audio";
  }

  if (await validatePlaybackControl(runtime, message, state, merged)) {
    return "play";
  }

  if (
    runtime.getService("musicLibrary") &&
    (await inferMusicLibraryOp(runtime, message, state, merged))
  ) {
    const libraryOp = await inferMusicLibraryOp(
      runtime,
      message,
      state,
      merged,
    );
    if (libraryOp === "playlist") {
      const playlistOp = resolvePlaylistOpFromOptions(merged, "playlist_play");
      return playlistOp === "save" ? "playlist_save" : "playlist_play";
    }
    if (libraryOp === "search_youtube") return "search";
    if (libraryOp === "play_query") return "play_query";
    if (libraryOp === "download") return "download";
  }

  if (
    await manageRouting.validate(
      runtime,
      message,
      state,
      jsonHandlerOptions(merged),
    )
  ) {
    return "set_routing";
  }

  if (
    await manageZones.validate(
      runtime,
      message,
      state,
      jsonHandlerOptions(merged),
    )
  ) {
    return "set_zone";
  }

  return null;
}

async function resolveSubaction(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  merged: Record<string, unknown>,
): Promise<MusicSubaction | null> {
  return readExplicitSubaction(merged) ?? (await inferSubactionFromText(
    runtime,
    message,
    state,
    merged,
  ));
}

function ensurePlaybackMerged(
  merged: Record<string, unknown>,
  message: Memory,
  forcedOp?: "pause" | "resume" | "skip" | "stop",
): Record<string, unknown> {
  const out = { ...merged };
  if (forcedOp) {
    out.op = forcedOp;
    return out;
  }
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
    "Unified music action. Use verb-shaped action for everything: " +
    "playback (play, pause, resume, skip, stop), queue (queue_view, queue_add, queue_clear), " +
    "library (playlist_play, playlist_save, search, play_query, download, play_audio), " +
    "routing/zones (set_routing, set_zone). " +
    "skip, stop, queue_add, queue_clear, playlist_save, and download require confirmed:true.",
  descriptionCompressed:
    "Verb-shaped: play/pause/resume/skip/stop, queue_view/queue_add/queue_clear, playlist_play/playlist_save, search/play_query/download/play_audio, set_routing/set_zone.",
  parameters: [
    {
      name: "action",
      description:
        "Verb-shaped subaction. Playback: play, pause, resume, skip, stop. " +
        "Queue: queue_view, queue_add, queue_clear. " +
        "Library: playlist_play, playlist_save, search, play_query, download, play_audio. " +
        "Routing/zones: set_routing, set_zone. Legacy aliases (e.g. queue, playlist, search_youtube, routing, zones) are still accepted.",
      required: false,
      schema: {
        type: "string",
        enum: [...MUSIC_SUBACTIONS],
      },
    },
    {
      name: "query",
      description: "Search/play/queue query depending on subaction.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "url",
      description: "Direct media URL when using play_audio or play.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "playlistName",
      description: "Playlist name for playlist_play / playlist_save.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "song",
      description: "Song query when adding to a playlist.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "limit",
      description: "Search result limit (search / library helpers).",
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
        "Structured routing operation when using set_routing (set_mode, start_route, …).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "mode",
      description: "Routing mode for set_routing operations.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "sourceId",
      description: "Stream/source id for set_routing.",
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
    const subaction = await resolveSubaction(runtime, message, state, merged);
    if (subaction) return true;
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
    const subaction = await resolveSubaction(runtime, message, state, merged);

    if (!subaction) {
      const text =
        "Could not classify a music subaction. Set action to one of: " +
        [...MUSIC_SUBACTIONS].join(", ") +
        ".";
      if (callback) {
        await callback({ text, source: message.content.source });
      }
      return { success: false, text, error: text };
    }

    const dispatch = dispatchKindFor(subaction, merged);

    switch (dispatch.kind) {
      case "playback": {
        const dispatchMerged = ensurePlaybackMerged(
          merged,
          message,
          dispatch.playbackOp,
        );
        return playbackOp.handler(
          runtime,
          message,
          state,
          jsonHandlerOptions(dispatchMerged),
          callback,
        );
      }
      case "queue_add": {
        const dispatchMerged = { ...merged, op: "queue" };
        return playbackOp.handler(
          runtime,
          message,
          state,
          jsonHandlerOptions(dispatchMerged),
          callback,
        );
      }
      case "queue_view": {
        if (!callback) {
          return { success: false, error: "Missing callback", text: "" };
        }
        const text =
          "Use the music UI to inspect the current queue, or ask 'show queue'.";
        await callback({ text, source: message.content.source });
        return {
          success: true,
          text,
          data: { subaction: "queue_view" },
        };
      }
      case "queue_clear": {
        const dispatchMerged = { ...merged, op: "stop" };
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
      case "library": {
        const dispatchMerged: Record<string, unknown> = {
          ...merged,
          subaction: dispatch.libraryOp,
        };
        if (dispatch.playlistOp) {
          dispatchMerged.playlistOp = dispatch.playlistOp;
        }
        return musicLibraryAction.handler(
          runtime,
          message,
          state,
          jsonHandlerOptions(dispatchMerged),
          callback,
        );
      }
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
