import {
  type ActionExample,
  type ActionResult,
  ChannelType,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
  type UUID,
} from "@elizaos/core";
import { loadPlaylists, savePlaylist } from "../components/playlists";
import type { Playlist } from "../components/playlists";
import type { MusicLibraryService } from "../services/musicLibraryService";
import {
  getSmartMusicFetchService,
  type MusicFetchProgress,
} from "../utils/smartFetchService";
import {
  confirmationRequired,
  isConfirmed,
  mergedOptions,
} from "./confirmation";

type PlaylistOp = "save" | "load" | "delete" | "add";

interface QueueTrack {
  url: string;
  title: string;
  duration?: number;
}

interface MusicQueueReadService {
  getQueueList(guildId: string): QueueTrack[];
  getCurrentTrack(guildId: string): QueueTrack | null;
}

interface MusicQueueAddService {
  addTrack(
    guildId: string,
    track: {
      url: string;
      title: string;
      duration?: number;
      requestedBy: UUID;
    },
  ): Promise<unknown>;
}

const MUSIC_SERVICE_NAME = "music";
const MUSIC_LIBRARY_SERVICE_NAME = "musicLibrary";

function normalizeOp(value: unknown): PlaylistOp | null {
  if (typeof value !== "string") return null;
  const v = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (v === "save" || v === "load" || v === "delete" || v === "add") return v;
  if (v === "remove") return "delete";
  if (v === "play" || v === "restore") return "load";
  if (v === "create" || v === "store") return "save";
  return null;
}

function readPlaylistOp(options: Record<string, unknown>, messageText: string) {
  return (
    normalizeOp(options.subaction) ??
    normalizeOp(options.playlistOp) ??
    normalizeOp(options.op) ??
    inferOpFromText(messageText)
  );
}

function inferOpFromText(text: string): PlaylistOp | null {
  const lower = text.toLowerCase();
  if (/\b(add|put)\b.+\b(to|in)\b.+\bplaylist\b/.test(lower)) return "add";
  if (/\b(delete|remove)\b.+\bplaylist\b/.test(lower)) return "delete";
  if (/\b(load|play|restore)\b.+\bplaylist\b/.test(lower)) return "load";
  if (/\b(save|create|store)\b.+\bplaylist\b/.test(lower)) return "save";
  return null;
}

function readPlaylistName(
  options: Record<string, unknown>,
  messageText: string,
  fallbackPattern?: RegExp,
): string | undefined {
  const direct = options.playlistName ?? options.name;
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct.trim();
  }
  const pattern =
    fallbackPattern ??
    /(?:save|load|create|store|restore|delete|remove|play).*?playlist.*?(?:named|called|as)?\s*["']?([^"']+)["']?/i;
  const match = messageText.match(pattern);
  if (match?.[1]) return match[1].trim();
  const quoted = messageText.match(/["']([^"']+)["']/);
  if (quoted?.[1]) return quoted[1].trim();
  return undefined;
}

async function handleSave(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: Record<string, unknown>,
  callback: HandlerCallback,
): Promise<ActionResult> {
  const musicService = runtime.getService(
    MUSIC_SERVICE_NAME,
  ) as MusicQueueReadService | null;
  if (!musicService) {
    const text = "Music service is not available.";
    await callback({ text, source: message.content.source });
    return { success: false, error: "Music service unavailable" };
  }

  const musicLibrary = runtime.getService(
    MUSIC_LIBRARY_SERVICE_NAME,
  ) as MusicLibraryService | null;
  if (!musicLibrary) {
    const text = "Music library service is not available.";
    await callback({ text, source: message.content.source });
    return { success: false, error: "Music library service unavailable" };
  }

  const room = state?.data?.room || (await runtime.getRoom(message.roomId));
  const currentServerId = room?.serverId;
  if (!currentServerId) {
    const text = "I could not determine which server you are in.";
    await callback({ text, source: message.content.source });
    return { success: false, error: "Missing server id" };
  }

  const queue = musicService.getQueueList(currentServerId);
  const currentTrack = musicService.getCurrentTrack(currentServerId);

  if (queue.length === 0 && !currentTrack) {
    const text =
      "The queue is empty. Add some tracks before saving a playlist.";
    await callback({ text, source: message.content.source });
    return { success: false, error: "Queue is empty" };
  }

  const userId = message.entityId as UUID;
  if (!userId) {
    const text = "I could not determine your user ID.";
    await callback({ text, source: message.content.source });
    return { success: false, error: "Missing user id" };
  }

  const messageText = message.content.text || "";
  const playlistName =
    readPlaylistName(options, messageText) ||
    `Playlist ${new Date().toLocaleDateString()}`;

  const tracks: Array<{ url: string; title: string; duration?: number }> = [];
  if (currentTrack) {
    tracks.push({
      url: currentTrack.url,
      title: currentTrack.title,
      duration: currentTrack.duration,
    });
  }
  for (const track of queue) {
    tracks.push({
      url: track.url,
      title: track.title,
      duration: track.duration,
    });
  }

  const preview = `Confirmation required before saving playlist "${playlistName}" with ${tracks.length} track${tracks.length !== 1 ? "s" : ""}.`;
  if (!isConfirmed(options)) {
    await callback({ text: preview, source: message.content.source });
    return confirmationRequired(preview, {
      op: "playlist",
      subaction: "save",
      playlistName,
      trackCount: tracks.length,
    });
  }

  const playlist: Omit<Playlist, "id" | "createdAt" | "updatedAt"> = {
    name: playlistName,
    tracks,
  };
  const saved = await musicLibrary.savePlaylist(userId, playlist);
  const isDM = room?.type === ChannelType.DM;

  let responseText = `Saved playlist "${saved.name}" with ${saved.tracks.length} track${saved.tracks.length !== 1 ? "s" : ""}.`;
  if (!isDM) {
    responseText +=
      " Tip: You can manage playlists in DMs to keep group chats clean.";
  }
  await callback({ text: responseText, source: message.content.source });
  return { success: true, text: responseText };
}

async function handleLoad(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: Record<string, unknown>,
  callback: HandlerCallback,
): Promise<ActionResult> {
  const musicService = runtime.getService(
    MUSIC_SERVICE_NAME,
  ) as MusicQueueAddService | null;
  if (!musicService) {
    const text = "Music service is not available.";
    await callback({ text, source: message.content.source });
    return { success: false, error: "Music service unavailable" };
  }

  const musicLibrary = runtime.getService(
    MUSIC_LIBRARY_SERVICE_NAME,
  ) as MusicLibraryService | null;
  if (!musicLibrary) {
    const text = "Music library service is not available.";
    await callback({ text, source: message.content.source });
    return { success: false, error: "Music library service unavailable" };
  }

  const room = state?.data?.room || (await runtime.getRoom(message.roomId));
  const currentServerId = room?.serverId;
  if (!currentServerId) {
    const text = "I could not determine which server you are in.";
    await callback({ text, source: message.content.source });
    return { success: false, error: "Missing server id" };
  }

  const userId = message.entityId as UUID;
  if (!userId) {
    const text = "I could not determine your user ID.";
    await callback({ text, source: message.content.source });
    return { success: false, error: "Missing user id" };
  }

  const playlists = await musicLibrary.loadPlaylists(userId);
  if (playlists.length === 0) {
    const text =
      "You don't have any saved playlists. Save a queue first using 'save playlist'.";
    await callback({ text, source: message.content.source });
    return { success: false, error: "No playlists available" };
  }

  const messageText = message.content.text || "";
  const requestedName = readPlaylistName(options, messageText);

  let selected: Playlist | undefined;
  if (requestedName) {
    selected = playlists.find(
      (p) => p.name.toLowerCase() === requestedName.toLowerCase(),
    );
    if (!selected) {
      const text = `I couldn't find a playlist named "${requestedName}". Your playlists: ${playlists.map((p) => `"${p.name}"`).join(", ")}`;
      await callback({ text, source: message.content.source });
      return { success: false, error: "Playlist not found" };
    }
  } else {
    selected = [...playlists].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }

  const preview = `Confirmation required before loading playlist "${selected.name}" and adding ${selected.tracks.length} track${selected.tracks.length !== 1 ? "s" : ""} to the queue.`;
  if (!isConfirmed(options)) {
    await callback({ text: preview, source: message.content.source });
    return confirmationRequired(preview, {
      op: "playlist",
      subaction: "load",
      playlistId: selected.id,
      playlistName: selected.name,
      trackCount: selected.tracks.length,
    });
  }

  for (const track of selected.tracks) {
    await musicService.addTrack(currentServerId, {
      url: track.url,
      title: track.title,
      duration: track.duration,
      requestedBy: userId,
    });
  }

  const isDM = room?.type === ChannelType.DM;
  const addedCount = selected.tracks.length;
  let responseText = `Loaded playlist "${selected.name}" and added ${addedCount} track${addedCount !== 1 ? "s" : ""} to the queue.`;
  if (!isDM) {
    responseText +=
      " Tip: You can manage playlists in DMs to keep group chats clean.";
  }
  await callback({ text: responseText, source: message.content.source });
  return { success: true, text: responseText };
}

async function handleDelete(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: Record<string, unknown>,
  callback: HandlerCallback,
): Promise<ActionResult> {
  const musicLibrary = runtime.getService(
    MUSIC_LIBRARY_SERVICE_NAME,
  ) as MusicLibraryService | null;
  if (!musicLibrary) {
    const text = "Music library service is not available.";
    await callback({ text, source: message.content.source });
    return { success: false, error: "Music library service unavailable" };
  }

  const userId = message.entityId as UUID;
  if (!userId) {
    const text = "I could not determine your user ID.";
    await callback({ text, source: message.content.source });
    return { success: false, error: "Missing user id" };
  }

  const playlists = await musicLibrary.loadPlaylists(userId);
  if (playlists.length === 0) {
    const text = "You don't have any saved playlists to delete.";
    await callback({ text, source: message.content.source });
    return { success: false, error: "No playlists available" };
  }

  const messageText = message.content.text || "";
  const playlistName = readPlaylistName(options, messageText);

  if (!playlistName) {
    const list = playlists.map((p) => `"${p.name}"`).join(", ");
    const text = `Please specify which playlist to delete. Your playlists: ${list}\n\nExample: "delete playlist My Favorites"`;
    await callback({ text, source: message.content.source });
    return { success: false, error: "Missing playlist name" };
  }

  const selected = playlists.find(
    (p) => p.name.toLowerCase() === playlistName.toLowerCase(),
  );
  if (!selected) {
    const list = playlists.map((p) => `"${p.name}"`).join(", ");
    const text = `I couldn't find a playlist named "${playlistName}". Your playlists: ${list}`;
    await callback({ text, source: message.content.source });
    return { success: false, error: "Playlist not found" };
  }

  const preview = `Confirmation required before deleting playlist "${selected.name}" (${selected.tracks.length} track${selected.tracks.length !== 1 ? "s" : ""}).`;
  if (!isConfirmed(options)) {
    await callback({ text: preview, source: message.content.source });
    return confirmationRequired(preview, {
      op: "playlist",
      subaction: "delete",
      playlistId: selected.id,
      playlistName: selected.name,
      trackCount: selected.tracks.length,
    });
  }

  const deleted = await musicLibrary.deletePlaylist(userId, selected.id);
  if (!deleted) {
    const text = "I encountered an error while deleting the playlist.";
    await callback({ text, source: message.content.source });
    return { success: false, error: "Delete failed" };
  }

  const room = state?.data?.room || (await runtime.getRoom(message.roomId));
  const isDM = room?.type === ChannelType.DM;
  let responseText = `Deleted playlist "${selected.name}".`;
  if (!isDM) {
    responseText +=
      " Tip: You can manage playlists in DMs to keep group chats clean.";
  }
  await callback({ text: responseText, source: message.content.source });
  return { success: true, text: responseText };
}

async function handleAdd(
  runtime: IAgentRuntime,
  message: Memory,
  options: Record<string, unknown>,
  callback: HandlerCallback,
): Promise<ActionResult> {
  const messageText = message.content.text || "";
  const directSong =
    typeof options.song === "string" && options.song.trim().length > 0
      ? options.song.trim()
      : typeof options.songQuery === "string" &&
          options.songQuery.trim().length > 0
        ? options.songQuery.trim()
        : typeof options.query === "string" && options.query.trim().length > 0
          ? options.query.trim()
          : undefined;
  const directName = readPlaylistName(options, "");

  let songQuery = directSong;
  let playlistName = directName;

  if (!songQuery || !playlistName) {
    const match = messageText.match(/add\s+(.+?)\s+to\s+(?:playlist\s+)?(.+)/i);
    if (match) {
      songQuery ||= match[1].trim();
      playlistName ||= match[2].trim();
    }
  }

  if (!songQuery || songQuery.length < 3) {
    const text =
      'Please specify what song to add and which playlist. Example: "add Bohemian Rhapsody to my favorites"';
    await callback({ text, source: message.content.source });
    return { success: false, error: "Missing song name" };
  }
  if (!playlistName || playlistName.length < 2) {
    const text = "Please specify a playlist name (at least 2 characters).";
    await callback({ text, source: message.content.source });
    return { success: false, error: "Missing playlist name" };
  }

  const preview = `Confirmation required before adding "${songQuery}" to playlist "${playlistName}".`;
  if (!isConfirmed(options)) {
    await callback({ text: preview, source: message.content.source });
    return confirmationRequired(preview, {
      op: "playlist",
      subaction: "add",
      songQuery,
      playlistName,
    });
  }

  const smartFetch = getSmartMusicFetchService(runtime);
  const preferredQuality =
    (runtime.getSetting("MUSIC_QUALITY_PREFERENCE") as string) || "mp3_320";

  await callback({
    text: `Searching for "${songQuery}"...`,
    source: message.content.source,
  });

  let lastProgress = "";
  const onProgress = async (progress: MusicFetchProgress) => {
    const label = progress.stage || progress.message || "working";
    const statusText = progress.details
      ? `${label}: ${String(progress.details)}`
      : label;
    if (statusText !== lastProgress) {
      lastProgress = statusText;
      logger.info(`[PLAYLIST_OP add] ${statusText}`);
    }
  };

  const result = await smartFetch.fetchMusic({
    query: songQuery,
    requestedBy: message.entityId,
    onProgress,
    preferredQuality: preferredQuality as "flac" | "mp3_320" | "any",
  });

  if (!result.success || !result.url) {
    const text = `Couldn't find or download "${songQuery}". ${result.error || "Please try a different search term."}`;
    await callback({ text, source: message.content.source });
    return { success: false, error: result.error || "Music not found" };
  }

  const existing = await loadPlaylists(runtime, message.entityId);
  let target = existing.find(
    (p) => p.name.toLowerCase() === playlistName.toLowerCase(),
  );
  if (!target) {
    target = {
      id: crypto.randomUUID(),
      name: playlistName,
      tracks: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  const trackExists = target.tracks.some((t) => t.url === result.url);
  if (trackExists) {
    const text = `**${result.title || songQuery}** is already in playlist "${playlistName}"`;
    await callback({ text, source: message.content.source });
    return { success: true, text };
  }

  target.tracks.push({
    url: result.url,
    title: result.title || songQuery,
    duration: result.duration,
    addedAt: Date.now(),
  });
  target.updatedAt = Date.now();
  await savePlaylist(runtime, message.entityId, target);

  let responseText = `Added **${result.title || songQuery}** to playlist "${playlistName}"`;
  if (result.source === "torrent") responseText += "\nFetched via torrent";
  responseText += `\nPlaylist now has ${target.tracks.length} track${target.tracks.length !== 1 ? "s" : ""}`;

  await callback({ text: responseText, source: message.content.source });

  await runtime.createMemory(
    {
      entityId: message.entityId,
      agentId: message.agentId,
      roomId: message.roomId,
      content: {
        source: message.content.source,
        thought: `Added ${result.title || songQuery} to playlist ${playlistName} (source: ${result.source})`,
        actions: ["MUSIC_LIBRARY"],
      },
      metadata: {
        type: "custom",
        actionName: "MUSIC_LIBRARY",
        legacyActionName: "PLAYLIST",
        op: "add",
        audioUrl: result.url,
        title: result.title || songQuery,
        playlistName,
        playlistId: target.id,
        source: result.source,
      },
    },
    "messages",
  );

  return { success: true, text: responseText };
}

export const playlistOpSimiles = [
  "PLAYLIST",
  "PLAYLIST_OP",
  "MUSIC_PLAYLIST",
  "SAVE_PLAYLIST",
  "LOAD_PLAYLIST",
  "DELETE_PLAYLIST",
  "ADD_TO_PLAYLIST",
  "REMOVE_PLAYLIST",
  "PLAY_PLAYLIST",
];

export const playlistOpExamples: ActionExample[][] = [
  [
    {
      name: "{{name1}}",
      content: { text: 'save this queue as playlist "Favorites"' },
    },
    {
      name: "{{agentName}}",
      content: {
        text: 'Confirmation required before saving playlist "Favorites".',
        actions: ["MUSIC_LIBRARY"],
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: { text: 'load my playlist "Workout"' },
    },
    {
      name: "{{agentName}}",
      content: {
        text: 'Confirmation required before loading playlist "Workout".',
        actions: ["MUSIC_LIBRARY"],
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: { text: "add Bohemian Rhapsody to my favorites" },
    },
    {
      name: "{{agentName}}",
      content: {
        text: 'Confirmation required before adding "Bohemian Rhapsody" to playlist "my favorites".',
        actions: ["MUSIC_LIBRARY"],
      },
    },
  ],
];

export async function validatePlaylistOp(
  _runtime: IAgentRuntime,
  message: Memory,
  _state?: State,
  options?: Record<string, unknown>,
): Promise<boolean> {
  const merged = mergedOptions(options);
  return Boolean(readPlaylistOp(merged, message.content?.text ?? ""));
}

export async function handlePlaylistOp(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: Record<string, unknown> | undefined,
  callback?: HandlerCallback,
): Promise<ActionResult | undefined> {
  if (!callback) return { success: false, error: "Missing callback" };
  const merged = mergedOptions(options);
  const op = readPlaylistOp(merged, message.content?.text ?? "");
  if (!op) {
    const text =
      "Could not determine playlist op. Use subaction=save, load, delete, or add.";
    await callback({ text, source: message.content.source });
    return { success: false, error: text };
  }

  if (op === "save")
    return handleSave(runtime, message, state, merged, callback);
  if (op === "load")
    return handleLoad(runtime, message, state, merged, callback);
  if (op === "delete")
    return handleDelete(runtime, message, state, merged, callback);
  return handleAdd(runtime, message, merged, callback);
}
