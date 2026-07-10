/**
 * Umbrella MUSIC action dispatcher for playback, queue, library, routing, and
 * generation subactions.
 *
 * It normalizes legacy aliases and routes structured action parameters to the
 * narrower handlers that own each music capability.
 */
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
import { logger, ModelType, parseKeyValueXml } from "@elizaos/core";
import { sunoGenerateMusicHandler } from "@elizaos/plugin-suno";
import { selectedContextMatches } from "../utils/selectedContextMatches";
import { mergedOptions } from "./confirmation";
import { manageRouting } from "./manageRouting";
import { manageZones } from "./manageZones";
import { MUSIC_LIBRARY_OP_ALIASES, musicLibraryAction } from "./musicLibrary";
import { playAudio } from "./playAudio";
import { normalizeOp, playbackOp } from "./playbackOp";

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
  "playlist_delete",
  "playlist_add",
  "search",
  "play_query",
  "download",
  "play_audio",
  // routing / zones
  "set_routing",
  "set_zone",
  // generation (absorbed from retired MUSIC_GENERATION action)
  "generate",
  "extend",
  "custom_generate",
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
  | { kind: "zones" }
  | {
      kind: "generation";
      generationOp: "generate" | "extend" | "custom_generate";
    };

type LibraryOp = "playlist" | "play_query" | "search_youtube" | "download";
type PlaylistOp = "save" | "load" | "delete" | "add";

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
  create_playlist: "playlist_save",
  delete_playlist: "playlist_delete",
  remove_playlist: "playlist_delete",
  add_to_playlist: "playlist_add",
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
  // generation aliases (absorbed from retired MUSIC_GENERATION action)
  generate_music: "generate",
  create_music: "generate",
  make_music: "generate",
  compose_music: "generate",
  custom: "custom_generate",
  custom_music: "custom_generate",
  extend_audio: "extend",
  lengthen: "extend",
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

const PLAYLIST_DELETE_TOKENS = new Set([
  "delete",
  "remove",
  "playlist_delete",
  "delete_playlist",
  "remove_playlist",
]);

const PLAYLIST_ADD_TOKENS = new Set(["add", "playlist_add", "add_to_playlist"]);

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

function readParsedAction(parsed: Record<string, unknown>): unknown {
  // parseKeyValueXml strips the <response> wrapper and returns its direct
  // children flat, so the action is always read from the top-level `action`
  // key — there is never a nested `response` object.
  return parsed.action;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Recover a canonical MUSIC subaction from model PROSE when strict-XML parsing
 * failed. The guarantee is honest ambiguity refusal: a clean single-token echo
 * ("pause", "queue add") resolves directly, but any prose that references more
 * than one distinct enum resolves to none. Every source — the ordered candidate
 * extractors (`<action>…`, `action[:=]…`, backtick, leading-bullet) AND the
 * word-boundary set-scan — contributes into a single `found` set, and the token
 * is returned only when exactly one distinct enum was seen overall. First-match
 * across candidates is deliberately NOT used: "It could be `pause`, but the
 * final enum may be skip." must refuse, not silently pick `pause`.
 */
function extractModelActionToken(text: string): MusicSubaction | null {
  const direct = normalizeSubaction(text);
  if (direct) return direct;

  const found = new Set<MusicSubaction>();

  const candidates = [
    text.match(/<action>\s*([^<]+?)\s*<\/action>/i)?.[1],
    text.match(/\baction\s*[:=]\s*["'`]?([a-z][a-z0-9_-]+)["'`]?/i)?.[1],
    text.match(/`([a-z][a-z0-9_-]+)`/)?.[1],
    text.match(/^\s*[-*]\s*([a-z][a-z0-9_-]+)\b/im)?.[1],
  ];
  for (const candidate of candidates) {
    const resolved = normalizeSubaction(candidate);
    if (resolved) found.add(resolved);
  }

  // Word-boundary set-scan: `[^a-zA-Z0-9_]` boundaries keep `play` from
  // matching inside `play_query` / `playlist_play`.
  for (const subaction of MUSIC_SUBACTIONS) {
    const pattern = new RegExp(
      `(^|[^a-zA-Z0-9_])${escapeRegExp(subaction)}([^a-zA-Z0-9_]|$)`,
      "i",
    );
    if (pattern.test(text)) found.add(subaction);
  }

  return found.size === 1 ? [...found][0] : null;
}

function getMessageText(message: Memory): string {
  return typeof message.content.text === "string" ? message.content.text : "";
}

function readString(merged: Record<string, unknown>, key: string): string {
  const value = merged[key];
  return typeof value === "string" ? value.trim() : "";
}

function readStringArray(
  merged: Record<string, unknown>,
  key: string,
): string[] {
  const value = merged[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function hasDirectUrl(merged: Record<string, unknown>): boolean {
  const candidates = [readString(merged, "url"), readString(merged, "query")];
  return candidates.some((value) => /^https?:\/\/\S+$/i.test(value));
}

function hasRoutingParams(merged: Record<string, unknown>): boolean {
  return (
    readString(merged, "routingAction").length > 0 ||
    readString(merged, "mode").length > 0 ||
    readString(merged, "sourceId").length > 0 ||
    readString(merged, "targetId").length > 0 ||
    readStringArray(merged, "targetIds").length > 0
  );
}

function hasZoneParams(merged: Record<string, unknown>): boolean {
  const operation = readString(merged, "operation").toLowerCase();
  return (
    (operation === "create" ||
      operation === "delete" ||
      operation === "show" ||
      operation === "list" ||
      operation === "add" ||
      operation === "remove") &&
    (operation === "list" ||
      readString(merged, "zoneName").length > 0 ||
      readString(merged, "targetId").length > 0 ||
      readStringArray(merged, "targetIds").length > 0)
  );
}

function hasGenerationParams(merged: Record<string, unknown>): boolean {
  return Boolean(
    readString(merged, "audio_id") ||
      readString(merged, "reference_audio") ||
      readString(merged, "style") ||
      typeof merged.bpm === "number" ||
      readString(merged, "key") ||
      readString(merged, "prompt"),
  );
}

/**
 * Pick the MUSIC subaction via model structured extraction when the planner did
 * not already provide an explicit action/op/subaction. This replaces the old
 * English regex fallback in the umbrella dispatcher (#10470); explicit enum
 * parameters and structural machine-format checks still take precedence.
 */
async function extractMusicSubactionFromText(
  runtime: IAgentRuntime,
  text: string,
): Promise<MusicSubaction | null> {
  if (!text.trim()) return null;
  const prompt = `A user asked the agent for a music operation. Pick the single MUSIC action enum that should handle the request. This must work in any language, so infer intent semantically instead of matching English words.

Allowed actions:
- play: play a direct URL or already-resolved audio item
- pause: pause current playback
- resume: resume paused playback
- skip: skip the current track
- stop: stop playback and clear the queue
- queue_view: show the current queue
- queue_add: add a requested track to the queue
- queue_clear: clear the queue
- playlist_play: load or play a saved playlist
- playlist_save: save the current queue or songs as a playlist
- playlist_delete: delete or remove a saved playlist
- playlist_add: add a requested song to a saved playlist
- search: search YouTube/music results without necessarily playing
- play_query: research/find music and play or queue the best match
- download: download/fetch music into the local library
- play_audio: play a direct media URL from the request
- set_routing: configure music routing/mode/source/targets
- set_zone: configure music zones
- generate: generate new music
- extend: extend an existing generated audio track
- custom_generate: generate music from custom style/reference/BPM/key settings

Request:
${text}

Output the single best-matching enum token only — no prose, no markdown, no explanation, no alternatives. If the request maps to several actions, choose the one that resolves it.

Return ONLY:
<response><action>play|pause|resume|skip|stop|queue_view|queue_add|queue_clear|playlist_play|playlist_save|playlist_delete|playlist_add|search|play_query|download|play_audio|set_routing|set_zone|generate|extend|custom_generate</action></response>`;

  try {
    const raw = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
    const cleaned = raw.replace(/```(?:xml)?/gi, "").trim();
    const wrapped = cleaned.includes("<response>")
      ? cleaned
      : `<response>${cleaned}</response>`;
    const parsed = parseKeyValueXml(wrapped) ?? {};
    return (
      normalizeSubaction(readParsedAction(parsed)) ??
      extractModelActionToken(cleaned)
    );
  } catch (error) {
    logger.warn(
      `[MUSIC] subaction extraction failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

function resolvePlaylistOpFromOptions(
  merged: Record<string, unknown>,
  subaction: MusicSubaction,
): PlaylistOp | null {
  if (subaction === "playlist_save") return "save";
  if (subaction === "playlist_play") return "load";
  if (subaction === "playlist_delete") return "delete";
  if (subaction === "playlist_add") return "add";
  const tokens = [merged.playlistOp, merged.subaction, merged.action, merged.op]
    .map((value) => normalizeToken(value))
    .filter((value): value is string => Boolean(value));
  for (const token of tokens) {
    if (PLAYLIST_LOAD_TOKENS.has(token)) return "load";
    if (PLAYLIST_SAVE_TOKENS.has(token)) return "save";
    if (PLAYLIST_DELETE_TOKENS.has(token)) return "delete";
    if (PLAYLIST_ADD_TOKENS.has(token)) return "add";
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
    case "playlist_delete":
      return {
        kind: "library",
        libraryOp: "playlist",
        playlistOp: "delete",
      };
    case "playlist_add":
      return {
        kind: "library",
        libraryOp: "playlist",
        playlistOp: "add",
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
    case "generate":
    case "extend":
    case "custom_generate":
      return { kind: "generation", generationOp: subaction };
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
  merged: Record<string, unknown>,
): Promise<MusicSubaction | null> {
  if (hasDirectUrl(merged)) {
    return "play_audio";
  }

  if (hasZoneParams(merged)) {
    return "set_zone";
  }

  if (hasRoutingParams(merged)) {
    return "set_routing";
  }

  if (runtime.getSetting("SUNO_API_KEY") && hasGenerationParams(merged)) {
    if (merged.audio_id) {
      return "extend";
    }
    // `mode` is intentionally not consulted here: any non-empty `mode` string is
    // already classified as set_routing by hasRoutingParams above, so it can
    // never reach this generation branch.
    if (merged.reference_audio || merged.style || merged.bpm || merged.key) {
      return "custom_generate";
    }
    if (merged.prompt) {
      return "generate";
    }
  }

  return null;
}

async function resolveSubaction(
  runtime: IAgentRuntime,
  message: Memory,
  _state: State | undefined,
  merged: Record<string, unknown>,
  options: { allowModelExtraction: boolean },
): Promise<MusicSubaction | null> {
  const explicit = readExplicitSubaction(merged);
  if (explicit) return explicit;

  const structural = await inferSubactionFromText(runtime, merged);
  if (structural) return structural;

  if (!options.allowModelExtraction) return null;
  return extractMusicSubactionFromText(runtime, getMessageText(message));
}

function ensurePlaybackMerged(
  merged: Record<string, unknown>,
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
  if (op) {
    out.op = op;
  }
  return out;
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
    "GENERATE_MUSIC",
    "CREATE_MUSIC",
    "MAKE_MUSIC",
    "COMPOSE_MUSIC",
    "CUSTOM_GENERATE_MUSIC",
    "EXTEND_AUDIO",
  ],
  description:
    "Music action. Use verb-shaped action for everything: " +
    "playback (play, pause, resume, skip, stop), queue (queue_view, queue_add, queue_clear), " +
    "library (playlist_play, playlist_save, playlist_delete, playlist_add, search, play_query, download, play_audio), " +
    "routing/zones (set_routing, set_zone), " +
    "generation (generate, extend, custom_generate — Suno-backed, requires SUNO_API_KEY). " +
    "skip, stop, queue_add, queue_clear, playlist_save, playlist_delete, playlist_add, and download require confirmation.",
  descriptionCompressed:
    "Verb-shaped: play/pause/resume/skip/stop, queue_view/queue_add/queue_clear, playlist_play/playlist_save/playlist_delete/playlist_add, search/play_query/download/play_audio, set_routing/set_zone, generate/extend/custom_generate.",
  parameters: [
    {
      name: "action",
      description:
        "Verb-shaped subaction. Playback: play, pause, resume, skip, stop. " +
        "Queue: queue_view, queue_add, queue_clear. " +
        "Library: playlist_play, playlist_save, playlist_delete, playlist_add, search, play_query, download, play_audio. " +
        "Routing/zones: set_routing, set_zone. " +
        "Generation (Suno): generate, extend, custom_generate. " +
        "Legacy aliases (e.g. queue, playlist, search_youtube, routing, zones, custom) are still accepted.",
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
      description:
        "Playlist name for playlist_play / playlist_save / playlist_delete / playlist_add.",
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
      name: "routingAction",
      description:
        "Structured routing action when using set_routing (set_mode, start_route, status, stop_route).",
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
    {
      name: "targetId",
      description: "Single routing or zone target id.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "prompt",
      description:
        "Suno generation prompt for action=generate/custom_generate.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "audio_id",
      description: "Existing Suno audio id when action=extend.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "duration",
      description:
        "Generation length in seconds for action=generate/custom_generate, or extension seconds for action=extend.",
      required: false,
      schema: { type: "number", default: 30 },
    },
    {
      name: "style",
      description: "Style hint for action=custom_generate (Suno).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "reference_audio",
      description: "Reference audio URL for action=custom_generate (Suno).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "bpm",
      description: "Target BPM for action=custom_generate (Suno).",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "key",
      description: "Musical key for action=custom_generate (Suno).",
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    options?: Record<string, unknown>,
  ): Promise<boolean> => {
    const merged = mergedOptions(options);
    if (readExplicitSubaction(merged)) return true;
    return selectedContextMatches(state, MUSIC_CONTEXTS, {
      includeContextRouting: true,
    });
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const merged = mergedOptions(options);
    const subaction = await resolveSubaction(runtime, message, state, merged, {
      allowModelExtraction: true,
    });

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
    const callbackFor = (actionName: string): HandlerCallback | undefined =>
      callback
        ? (response, routedActionName) =>
            callback(response, routedActionName ?? actionName)
        : undefined;

    switch (dispatch.kind) {
      case "playback": {
        const dispatchMerged = ensurePlaybackMerged(
          merged,
          dispatch.playbackOp,
        );
        return playbackOp.handler(
          runtime,
          message,
          state,
          jsonHandlerOptions(dispatchMerged),
          callbackFor(playbackOp.name),
        );
      }
      case "queue_add": {
        const dispatchMerged = { ...merged, op: "queue" };
        return playbackOp.handler(
          runtime,
          message,
          state,
          jsonHandlerOptions(dispatchMerged),
          callbackFor(playbackOp.name),
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
          callbackFor(playbackOp.name),
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
          callbackFor(playAudio.name),
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
          callbackFor(musicLibraryAction.name),
        );
      }
      case "routing":
        return manageRouting.handler(
          runtime,
          message,
          state,
          jsonHandlerOptions(merged),
          callbackFor(manageRouting.name),
        );
      case "zones":
        return manageZones.handler(
          runtime,
          message,
          state,
          jsonHandlerOptions(merged),
          callbackFor(manageZones.name),
        );
      case "generation": {
        const dispatchMerged = { ...merged, action: dispatch.generationOp };
        return sunoGenerateMusicHandler(
          runtime,
          message,
          state ?? ({} as State),
          jsonHandlerOptions(dispatchMerged),
          callbackFor("GENERATE_MUSIC"),
        );
      }
      default:
        return { success: false, error: "Unreachable", text: "" };
    }
  },
  examples: musicExamples,
};

export default musicAction;
