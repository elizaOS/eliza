import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { mergedOptions } from "./confirmation";
import {
  downloadMusicExamples,
  downloadMusicSimiles,
  handleDownloadMusic,
  validateDownloadMusic,
} from "./downloadMusic";
import {
  handlePlaylistOp,
  playlistOpExamples,
  playlistOpSimiles,
  validatePlaylistOp,
} from "./playlistOp";
import {
  handlePlayMusicQuery,
  playMusicQueryExamples,
  playMusicQuerySimiles,
  validatePlayMusicQuery,
} from "./playMusicQuery";
import {
  handleSearchYouTube,
  searchYouTubeExamples,
  searchYouTubeSimiles,
  validateSearchYouTube,
} from "./searchYouTube";

type MusicLibraryOp = "playlist" | "play_query" | "search_youtube" | "download";

const MUSIC_LIBRARY_OPS = [
  "playlist",
  "play_query",
  "search_youtube",
  "download",
] as const;

const MUSIC_LIBRARY_CONTEXTS = [
  "media",
  "automation",
  "knowledge",
  "web",
  "files",
] as const;

const PLAYLIST_SUBACTIONS = new Set([
  "save",
  "load",
  "delete",
  "add",
  "remove",
  "play",
  "restore",
  "create",
  "store",
]);

const OP_ALIASES: Record<string, MusicLibraryOp> = {
  add_to_playlist: "playlist",
  delete_playlist: "playlist",
  download_music: "download",
  download_song: "download",
  fetch_music: "download",
  find_and_play: "play_query",
  find_song: "search_youtube",
  find_youtube: "search_youtube",
  get_music: "download",
  get_youtube_link: "search_youtube",
  grab_music: "download",
  intelligent_music_search: "play_query",
  load_playlist: "playlist",
  lookup_youtube: "search_youtube",
  music_playlist: "playlist",
  play: "play_query",
  play_music_query: "play_query",
  play_playlist: "playlist",
  play_query: "play_query",
  playlist_op: "playlist",
  remove_playlist: "playlist",
  research_and_play: "play_query",
  save_music: "download",
  save_playlist: "playlist",
  search: "search_youtube",
  search_music: "search_youtube",
  search_youtube: "search_youtube",
  search_youtube_video: "search_youtube",
  smart_play: "play_query",
  youtube: "search_youtube",
};

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeSubaction(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return normalized.length > 0 ? normalized : null;
}

function normalizeMusicLibraryOp(value: unknown): MusicLibraryOp | null {
  const normalized = normalizeSubaction(value);
  if (!normalized) return null;
  if ((MUSIC_LIBRARY_OPS as readonly string[]).includes(normalized)) {
    return normalized as MusicLibraryOp;
  }
  if (PLAYLIST_SUBACTIONS.has(normalized)) return "playlist";
  return OP_ALIASES[normalized] ?? null;
}

function readExplicitOp(
  options: Record<string, unknown>,
): MusicLibraryOp | null {
  return (
    normalizeMusicLibraryOp(options.op) ??
    normalizeMusicLibraryOp(options.action) ??
    normalizeMusicLibraryOp(options.subaction)
  );
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

async function inferMusicLibraryOp(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: Record<string, unknown>,
): Promise<MusicLibraryOp | null> {
  const explicit = readExplicitOp(options);
  if (explicit) return explicit;
  if (await validatePlaylistOp(runtime, message, state, options)) {
    return "playlist";
  }
  if (await validateSearchYouTube(runtime, message, state, options)) {
    return "search_youtube";
  }
  if (await validatePlayMusicQuery(runtime, message, state)) {
    return "play_query";
  }
  if (await validateDownloadMusic(runtime, message, state, options)) {
    return "download";
  }
  return null;
}

const musicLibraryExamples: ActionExample[][] = [
  ...playlistOpExamples,
  ...playMusicQueryExamples,
  ...searchYouTubeExamples,
  ...downloadMusicExamples,
];

export const musicLibraryAction: Action = {
  name: "MUSIC_LIBRARY",
  contexts: [...MUSIC_LIBRARY_CONTEXTS],
  contextGate: { anyOf: [...MUSIC_LIBRARY_CONTEXTS] },
  roleGate: { minRole: "USER" },
  similes: unique([
    ...playlistOpSimiles,
    ...playMusicQuerySimiles,
    ...searchYouTubeSimiles,
    ...downloadMusicSimiles,
  ]),
  description:
    "Consolidated music library action. Use op=playlist with subaction=save, load, delete, or add for playlist management; op=play-query to research and queue complex music requests; op=search-youtube to return YouTube links; op=download to fetch music into the local library. Queue changes, downloads, and playlist mutations require confirmed:true.",
  descriptionCompressed:
    "Music library ops: playlist(subaction save/load/delete/add), play-query, search-youtube, download. Mutations require confirmed:true.",
  parameters: [
    {
      name: "op",
      description:
        "Music library operation: playlist, play-query, search-youtube, or download.",
      required: true,
      schema: {
        type: "string",
        enum: [
          "playlist",
          "play-query",
          "play_query",
          "search-youtube",
          "search_youtube",
          "download",
        ],
      },
    },
    {
      name: "subaction",
      description:
        "Playlist subaction when op=playlist: save, load, delete, or add.",
      required: false,
      schema: { type: "string", enum: ["save", "load", "delete", "add"] },
    },
    {
      name: "query",
      description:
        "Song, artist, album, or video query for play-query, search-youtube, download, or playlist add.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "playlistName",
      description: "Playlist name for playlist save, load, delete, or add.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "song",
      description: "Song query for playlist subaction=add.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "limit",
      description: "Maximum YouTube search results to inspect.",
      required: false,
      schema: { type: "number", minimum: 1, maximum: 10, default: 5 },
    },
    {
      name: "confirmed",
      description:
        "Must be true before queue changes, downloads, or playlist mutations.",
      required: false,
      schema: { type: "boolean", default: false },
    },
  ],
  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    options?: Record<string, unknown>,
  ): Promise<boolean> => {
    const merged = mergedOptions(options);
    const service = runtime.getService("musicLibrary");
    return Boolean(
      service &&
        (readExplicitOp(merged) ||
          selectedContextMatches(state, MUSIC_LIBRARY_CONTEXTS)),
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const merged = mergedOptions(options);
    const op = await inferMusicLibraryOp(runtime, message, state, merged);

    if (!op) {
      const text =
        "Could not determine music library op. Use op=playlist, play-query, search-youtube, or download.";
      if (callback) await callback({ text, source: message.content.source });
      return { success: false, error: text };
    }

    if (op === "playlist") {
      return handlePlaylistOp(runtime, message, state, merged, callback);
    }
    if (op === "play_query") {
      return handlePlayMusicQuery(runtime, message, state, merged, callback);
    }
    if (op === "search_youtube") {
      return handleSearchYouTube(runtime, message, state, merged, callback);
    }
    return handleDownloadMusic(runtime, message, state, merged, callback);
  },
  examples: musicLibraryExamples,
};

export default musicLibraryAction;
