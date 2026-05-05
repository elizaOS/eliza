import {
  type Action,
  type ActionExample,
  type ActionResult,
  encodeToonValue,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import type { MusicLibraryService } from "../services/musicLibraryService";
import { MUSIC_INFO_ACTION_DOCS } from "../prompts/musicInfoInstructions";
import addToPlaylist from "./addToPlaylist";
import deletePlaylist from "./deletePlaylist";
import downloadMusic from "./downloadMusic";
import listPlaylists from "./listPlaylists";
import loadPlaylist from "./loadPlaylist";
import playMusicQuery from "./playMusicQuery";
import savePlaylist from "./savePlaylist";
import searchYouTube from "./searchYouTube";

type RouterOptions = Parameters<Action["handler"]>[3];
type PlaylistSubaction = "save" | "load" | "list" | "delete" | "add";
type LibrarySubaction = "download";
type MetadataSubaction = "youtube" | "wikipedia" | "resolve_and_queue";
type MusicEntityType = "artist" | "album" | "song";

function paramsFromOptions(options: RouterOptions): Record<string, unknown> {
  const direct = (options ?? {}) as Record<string, unknown>;
  const parameters =
    direct.parameters && typeof direct.parameters === "object"
      ? (direct.parameters as Record<string, unknown>)
      : {};
  return { ...direct, ...parameters };
}

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function messageText(message: Memory): string {
  return message.content?.text ?? "";
}

function explicitSubaction(options: RouterOptions): string {
  const params = paramsFromOptions(options);
  return normalize(params.subaction ?? params.operation ?? params.action);
}

function inferPlaylistSubaction(
  message: Memory,
  options?: RouterOptions,
): PlaylistSubaction | null {
  const explicit = explicitSubaction(options);
  if (["save", "load", "list", "delete", "add"].includes(explicit)) {
    return explicit as PlaylistSubaction;
  }
  const text = messageText(message).toLowerCase();
  if (/\b(add|put|save)\b.+\b(to|in)\b.+\bplaylist\b/.test(text)) {
    return "add";
  }
  if (/\b(delete|remove)\b.+\bplaylist\b/.test(text)) return "delete";
  if (/\b(load|play|restore)\b.+\bplaylist\b/.test(text)) return "load";
  if (/\b(list|show|view|my)\b.+\bplaylists?\b/.test(text)) return "list";
  if (/\b(save|create|store)\b.+\bplaylist\b/.test(text)) return "save";
  return null;
}

function inferLibrarySubaction(
  message: Memory,
  options?: RouterOptions,
): LibrarySubaction | null {
  const explicit = explicitSubaction(options);
  if (explicit === "download" || explicit === "fetch") return "download";
  const text = messageText(message).toLowerCase();
  if (
    /\b(download|fetch|grab|get)\b.+\b(music|song|track|album)\b/.test(text)
  ) {
    return "download";
  }
  return null;
}

function inferMetadataSubaction(
  message: Memory,
  options?: RouterOptions,
): MetadataSubaction | null {
  const explicit = explicitSubaction(options);
  if (["youtube", "wikipedia", "resolve_and_queue"].includes(explicit)) {
    return explicit as MetadataSubaction;
  }
  if (explicit === "play_query" || explicit === "smart_play") {
    return "resolve_and_queue";
  }

  const text = messageText(message).toLowerCase();
  if (
    /\b(play|queue)\b/.test(text) &&
    /\b(first|latest|similar|80s|90s|2000s|soundtrack|cover|remix|acoustic|workout|study|party|chill|album|chart|trending)\b/.test(
      text,
    )
  ) {
    return "resolve_and_queue";
  }
  if (
    /\b(youtube|video|link|url)\b/.test(text) &&
    /\b(search|find|look up|get|show)\b/.test(text)
  ) {
    return "youtube";
  }
  if (
    /\b(wikipedia|artist info|song info|album info|tell me about|who is|who are|what is)\b/.test(
      text,
    )
  ) {
    return "wikipedia";
  }
  return null;
}

async function delegate(
  action: Action,
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: RouterOptions,
  callback?: HandlerCallback,
): Promise<ActionResult | undefined> {
  return action.handler(runtime, message, state as State, options, callback);
}

function getQuery(message: Memory, options: RouterOptions): string {
  const params = paramsFromOptions(options);
  const query = params.query ?? params.text ?? params.entity ?? params.artist;
  if (typeof query === "string" && query.trim().length > 0) {
    return query.trim();
  }
  return messageText(message)
    .replace(
      /\b(?:wikipedia|artist info|song info|album info|tell me about|who is|who are|what is|look up|search|find|get|show me)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function messageWithQuery(
  message: Memory,
  options: RouterOptions,
  prefix: string,
): Memory {
  const query = getQuery(message, options);
  if (!query || messageText(message).trim().length > 0) {
    return message;
  }
  return {
    ...message,
    content: {
      ...message.content,
      text: `${prefix} ${query}`.trim(),
    },
  };
}

function inferEntityType(
  message: Memory,
  options: RouterOptions,
): MusicEntityType {
  const explicit = normalize(paramsFromOptions(options).entityType);
  if (explicit === "artist" || explicit === "album" || explicit === "song") {
    return explicit;
  }
  const text = messageText(message).toLowerCase();
  if (/\balbum\b/.test(text)) return "album";
  if (/\bsong|track\b/.test(text)) return "song";
  return "artist";
}

async function handleWikipediaLookup(
  runtime: IAgentRuntime,
  message: Memory,
  options: RouterOptions,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const musicLibrary = runtime.getService(
    "musicLibrary",
  ) as MusicLibraryService | null;
  if (!musicLibrary) {
    const text = "Music library service is not available.";
    await callback?.({ text, source: message.content.source });
    return { success: false, error: text };
  }

  const params = paramsFromOptions(options);
  const query = getQuery(message, options);
  if (!query || query.length < 2) {
    const text = "Please provide an artist, album, or song to look up.";
    await callback?.({ text, source: message.content.source });
    return { success: false, error: "Missing query" };
  }

  const entityType = inferEntityType(message, options);
  const artist =
    typeof params.artist === "string" && params.artist.trim().length > 0
      ? params.artist.trim()
      : undefined;

  try {
    const result =
      entityType === "album"
        ? await musicLibrary.getWikipediaAlbumInfo(query, artist)
        : entityType === "song"
          ? await musicLibrary.getWikipediaTrackInfo(query, artist)
          : await musicLibrary.getWikipediaArtistInfo(query);

    if (!result) {
      const text = `No Wikipedia music metadata found for "${query}".`;
      await callback?.({ text, source: message.content.source });
      return { success: false, error: "No result" };
    }

    const text = encodeToonValue({
      wikipedia_music_result: {
        entity_type: entityType,
        query,
        result,
      },
    });
    await callback?.({ text, source: message.content.source });
    return { success: true, text, data: { entityType, query, result } };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(
      "Error in MUSIC_METADATA_SEARCH wikipedia lookup:",
      errorMessage,
    );
    await callback?.({
      text: `I encountered an error looking up "${query}". ${errorMessage}`,
      source: message.content.source,
    });
    return { success: false, error: errorMessage };
  }
}

export const musicPlaylist: Action = {
  name: "MUSIC_PLAYLIST",
  similes: [
    "SAVE_PLAYLIST",
    "LOAD_PLAYLIST",
    "LIST_PLAYLISTS",
    "DELETE_PLAYLIST",
    "ADD_TO_PLAYLIST",
  ],
  description:
    "Playlist router. Use subaction save, load, list, delete, or add. Save/load/delete/add require confirmed:true when changing queue or saved playlists.",
  descriptionCompressed: "Playlist router: save, load, list, delete, add.",
  parameters: [
    {
      name: "subaction",
      description: "Playlist operation: save, load, list, delete, or add.",
      required: false,
      schema: {
        type: "string",
        enum: ["save", "load", "list", "delete", "add"],
      },
    },
    {
      name: "confirmed",
      description: "Must be true for state-changing playlist operations.",
      required: false,
      schema: { type: "boolean", default: false },
    },
  ],
  validate: async (_runtime, message, options) =>
    Boolean(inferPlaylistSubaction(message, options as RouterOptions)),
  handler: async (runtime, message, state, options, callback) => {
    const subaction = inferPlaylistSubaction(message, options);
    if (!subaction) {
      const text =
        "Could not determine playlist subaction. Use save, load, list, delete, or add.";
      await callback?.({ text, source: message.content.source });
      return { success: false, error: text };
    }

    const actionBySubaction: Record<PlaylistSubaction, Action> = {
      save: savePlaylist,
      load: loadPlaylist,
      list: listPlaylists,
      delete: deletePlaylist,
      add: addToPlaylist,
    };

    return delegate(
      actionBySubaction[subaction],
      runtime,
      message,
      state,
      options,
      callback,
    );
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: 'save this queue as playlist "Favorites"' },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Confirmation required before saving playlist "Favorites".',
          actions: ["MUSIC_PLAYLIST"],
        },
      },
    ],
  ] as ActionExample[][],
};

export const musicLibrary: Action = {
  name: "MUSIC_LIBRARY",
  similes: ["DOWNLOAD_MUSIC", "FETCH_MUSIC", "GET_MUSIC", "SAVE_MUSIC"],
  description:
    "Music library router. Use subaction download to fetch music into the local library without playing it. Requires confirmed:true before downloading.",
  descriptionCompressed: "Library router: download music into local library.",
  parameters: [
    {
      name: "subaction",
      description: "Library operation. Currently: download.",
      required: false,
      schema: { type: "string", enum: ["download"] },
    },
    {
      name: "confirmed",
      description: "Must be true to download music.",
      required: false,
      schema: { type: "boolean", default: false },
    },
  ],
  validate: async (_runtime, message, options) =>
    Boolean(inferLibrarySubaction(message, options as RouterOptions)),
  handler: async (runtime, message, state, options, callback) => {
    const subaction = inferLibrarySubaction(message, options);
    if (subaction !== "download") {
      const text = "Could not determine library subaction. Use download.";
      await callback?.({ text, source: message.content.source });
      return { success: false, error: text };
    }
    return delegate(
      downloadMusic,
      runtime,
      messageWithQuery(message, options, "download"),
      state,
      options,
      callback,
    );
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "download Comfortably Numb by Pink Floyd" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Confirmation required before downloading music to the library.",
          actions: ["MUSIC_LIBRARY"],
        },
      },
    ],
  ] as ActionExample[][],
};

export const musicMetadataSearch: Action = {
  name: "MUSIC_METADATA_SEARCH",
  similes: [
    "SEARCH_YOUTUBE",
    "FIND_YOUTUBE",
    "PLAY_MUSIC_QUERY",
    "RESEARCH_AND_PLAY",
    "WIKIPEDIA_MUSIC",
    "MUSIC_INFO_SEARCH",
  ],
  description:
    "Music metadata/search router. Use subaction youtube to return YouTube links, wikipedia to look up artist/album/song metadata, or resolve_and_queue for complex music requests that need research before queueing. " +
    MUSIC_INFO_ACTION_DOCS,
  descriptionCompressed:
    "Music metadata/search: YouTube links, Wikipedia metadata, resolve complex query and queue.",
  parameters: [
    {
      name: "subaction",
      description:
        "Search operation: youtube, wikipedia, or resolve_and_queue.",
      required: false,
      schema: {
        type: "string",
        enum: ["youtube", "wikipedia", "resolve_and_queue"],
      },
    },
    {
      name: "query",
      description: "Search or metadata lookup query.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "entityType",
      description: "For wikipedia subaction: artist, album, or song.",
      required: false,
      schema: { type: "string", enum: ["artist", "album", "song"] },
    },
    {
      name: "confirmed",
      description: "Must be true for resolve_and_queue.",
      required: false,
      schema: { type: "boolean", default: false },
    },
  ],
  validate: async (_runtime, message, options) =>
    Boolean(inferMetadataSubaction(message, options as RouterOptions)),
  handler: async (runtime, message, state, options, callback) => {
    const subaction = inferMetadataSubaction(message, options);
    if (!subaction) {
      const text =
        "Could not determine metadata/search subaction. Use youtube, wikipedia, or resolve_and_queue.";
      await callback?.({ text, source: message.content.source });
      return { success: false, error: text };
    }

    if (subaction === "youtube") {
      return delegate(
        searchYouTube,
        runtime,
        messageWithQuery(message, options, "youtube search for"),
        state,
        options,
        callback,
      );
    }
    if (subaction === "resolve_and_queue") {
      return delegate(
        playMusicQuery,
        runtime,
        messageWithQuery(message, options, "play"),
        state,
        options,
        callback,
      );
    }
    return handleWikipediaLookup(runtime, message, options, callback);
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "find the YouTube link for Surefire by Wilderado" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Found it.",
          actions: ["MUSIC_METADATA_SEARCH"],
        },
      },
    ],
  ] as ActionExample[][],
};
