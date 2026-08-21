/**
 * The SPOTIFY umbrella action: one planner-facing tool whose `action`
 * discriminator routes to the music-domain subactions (search, saved-track
 * library reads/writes, playlist reads/writes, playback transport, and
 * device handoff). Handlers validate their inputs, delegate to
 * `SpotifyService`, and translate the plugin's typed error codes into
 * distinct user-facing failures — premium-gated playback, no active device,
 * rate limiting, and revoked auth each read differently instead of collapsing
 * into one generic error. Write subactions return a receipt naming the exact
 * mutation so replies cannot embellish what happened.
 */
import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { ElizaError } from "@elizaos/core";
import type { SpotifyService } from "./service";
import {
  SPOTIFY_SERVICE_NAME,
  type SpotifyDevice,
  type SpotifyPlaylistSummary,
  type SpotifySearchType,
  type SpotifyTrack,
} from "./types";

const SPOTIFY_SUBACTIONS = [
  "search",
  "library_list",
  "library_save",
  "library_remove",
  "playlist_list",
  "playlist_create",
  "playlist_add",
  "playback_state",
  "play",
  "pause",
  "next",
  "previous",
  "devices",
  "transfer",
] as const;
type SpotifySubaction = (typeof SPOTIFY_SUBACTIONS)[number];

type Params = Record<string, unknown>;

function parameters(message: Memory, options?: HandlerOptions | Record<string, unknown>): Params {
  const optionRecord = (options ?? {}) as Record<string, unknown>;
  const nested = optionRecord.parameters;
  const values: Record<string, unknown> = {
    ...(nested && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : {}),
  };
  if (message.content && typeof message.content === "object") {
    for (const [key, value] of Object.entries(message.content)) {
      if (values[key] === undefined) values[key] = value;
    }
  }
  return values;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return undefined;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeSubaction(value: unknown): SpotifySubaction | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return SPOTIFY_SUBACTIONS.includes(normalized as SpotifySubaction)
    ? (normalized as SpotifySubaction)
    : null;
}

function describeTrack(track: SpotifyTrack): string {
  const artists = track.artists.map((artist) => artist.name).join(", ");
  return artists ? `${track.name} — ${artists}` : track.name;
}

function describePlaylist(playlist: SpotifyPlaylistSummary): string {
  return `${playlist.name} (${playlist.trackCount} tracks)`;
}

function describeDevice(device: SpotifyDevice): string {
  return `${device.name} [${device.type}]${device.isActive ? " (active)" : ""}`;
}

function invalidInput(subaction: SpotifySubaction, reason: string): ActionResult {
  return {
    success: false,
    text: reason,
    userFacingText: reason,
    verifiedUserFacing: true,
    data: { actionName: "SPOTIFY", action: subaction, reason: "invalid_input" },
  };
}

function failureFromError(subaction: SpotifySubaction, error: unknown): ActionResult {
  const code = error instanceof ElizaError ? error.code : undefined;
  const messages: Record<string, string> = {
    SPOTIFY_AUTH_REQUIRED:
      "No Spotify account is connected. Connect Spotify in settings (managed OAuth) or configure the SPOTIFY_* settings for local mode.",
    SPOTIFY_AUTH_REVOKED:
      "The Spotify authorization is no longer valid. Reconnect the Spotify account to continue.",
    SPOTIFY_PREMIUM_REQUIRED:
      "Spotify playback control requires a Premium subscription; this account is on the free tier.",
    SPOTIFY_NO_ACTIVE_DEVICE:
      "No active Spotify device was found. Open Spotify on a device, or list devices and transfer playback to one.",
    SPOTIFY_RATE_LIMITED: "Spotify is rate limiting requests right now; try again shortly.",
    SPOTIFY_SCOPE_INSUFFICIENT:
      "The connected Spotify account has not granted this permission. Reconnect to grant the missing scope.",
    SPOTIFY_CONFIG_MISSING:
      "Spotify is not configured. Set SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET (and SPOTIFY_REFRESH_TOKEN for local mode).",
    SPOTIFY_NOT_FOUND: "Spotify could not find the requested item.",
    SPOTIFY_INVALID_INPUT: error instanceof Error ? error.message : "Invalid Spotify request.",
  };
  const message =
    (code && messages[code]) ??
    (error instanceof Error
      ? `Spotify request failed: ${error.message}`
      : "Spotify request failed.");
  return {
    success: false,
    text: message,
    userFacingText: message,
    verifiedUserFacing: true,
    data: {
      actionName: "SPOTIFY",
      action: subaction,
      errorCode: code ?? "SPOTIFY_UPSTREAM_FAILED",
    },
  };
}

function success(
  subaction: SpotifySubaction,
  userFacingText: string,
  data: Record<string, unknown>
): ActionResult {
  return {
    success: true,
    text: userFacingText,
    userFacingText,
    verifiedUserFacing: true,
    data: { actionName: "SPOTIFY", action: subaction, ...data },
  };
}

function getSpotifyService(runtime: IAgentRuntime): SpotifyService {
  const service = runtime.getService(SPOTIFY_SERVICE_NAME) as SpotifyService | null;
  if (!service) {
    throw new ElizaError("SpotifyService is not registered on this runtime.", {
      code: "SPOTIFY_CONFIG_MISSING",
      severity: "fatal",
    });
  }
  return service;
}

async function execute(
  runtime: IAgentRuntime,
  subaction: SpotifySubaction,
  params: Params
): Promise<ActionResult> {
  const service = getSpotifyService(runtime);
  const accountId = await service.resolveAccountId(text(params.accountId));
  const ref = { accountId };
  const limit = positiveInt(params.limit);
  const offset = positiveInt(params.offset);
  const paging = {
    ...(limit !== undefined ? { limit } : {}),
    ...(offset !== undefined ? { offset } : {}),
  };

  switch (subaction) {
    case "search": {
      const query = text(params.query);
      if (!query) return invalidInput(subaction, "Spotify search needs a query.");
      const rawTypes = stringList(params.types).filter((t): t is SpotifySearchType =>
        ["track", "album", "artist", "playlist"].includes(t)
      );
      const types: SpotifySearchType[] = rawTypes.length > 0 ? rawTypes : ["track"];
      const found = await service.search(ref, query, types, paging);
      const lines = [
        ...found.tracks.map((track) => `- ${describeTrack(track)} (${track.uri})`),
        ...found.playlists.map((playlist) => `- ${describePlaylist(playlist)} (${playlist.uri})`),
      ];
      const summary =
        lines.length > 0
          ? `Spotify results for "${query}":\n${lines.join("\n")}`
          : `No Spotify results for "${query}".`;
      return success(subaction, summary, {
        tracks: found.tracks as unknown as Record<string, unknown>[],
        playlists: found.playlists as unknown as Record<string, unknown>[],
      });
    }
    case "library_list": {
      const page = await service.listSavedTracks(ref, paging);
      const summary =
        page.items.length > 0
          ? `Saved tracks (${page.total} total):\n${page.items
              .map((track) => `- ${describeTrack(track)}`)
              .join(
                "\n"
              )}${page.nextOffset !== null ? `\nMore available at offset ${page.nextOffset}.` : ""}`
          : "The Spotify library has no saved tracks.";
      return success(subaction, summary, {
        tracks: page.items as unknown as Record<string, unknown>[],
        total: page.total,
        nextOffset: page.nextOffset,
      });
    }
    case "library_save": {
      const ids = stringList(params.trackIds);
      if (ids.length === 0) return invalidInput(subaction, "Saving tracks needs trackIds.");
      await service.saveTracks(ref, ids);
      return success(subaction, `Saved ${ids.length} track(s) to the Spotify library.`, {
        receipt: { operation: "library_save", target: "me/tracks", detail: ids.join(",") },
      });
    }
    case "library_remove": {
      const ids = stringList(params.trackIds);
      if (ids.length === 0) return invalidInput(subaction, "Removing tracks needs trackIds.");
      await service.removeSavedTracks(ref, ids);
      return success(subaction, `Removed ${ids.length} track(s) from the Spotify library.`, {
        receipt: { operation: "library_remove", target: "me/tracks", detail: ids.join(",") },
      });
    }
    case "playlist_list": {
      const page = await service.listPlaylists(ref, paging);
      const summary =
        page.items.length > 0
          ? `Playlists (${page.total} total):\n${page.items
              .map((playlist) => `- ${describePlaylist(playlist)}`)
              .join(
                "\n"
              )}${page.nextOffset !== null ? `\nMore available at offset ${page.nextOffset}.` : ""}`
          : "This Spotify account has no playlists.";
      return success(subaction, summary, {
        playlists: page.items as unknown as Record<string, unknown>[],
        total: page.total,
        nextOffset: page.nextOffset,
      });
    }
    case "playlist_create": {
      const name = text(params.name);
      if (!name) return invalidInput(subaction, "Creating a playlist needs a name.");
      const description = text(params.description);
      const playlist = await service.createPlaylist(ref, {
        name,
        ...(description !== undefined ? { description } : {}),
        isPublic: params.public === true,
      });
      return success(subaction, `Created playlist "${playlist.name}" (${playlist.id}).`, {
        playlist: playlist as unknown as Record<string, unknown>,
        receipt: { operation: "playlist_create", target: playlist.id, detail: playlist.name },
      });
    }
    case "playlist_add": {
      const playlistId = text(params.playlistId);
      const uris = stringList(params.trackUris);
      if (!playlistId) return invalidInput(subaction, "Adding tracks needs a playlistId.");
      if (uris.length === 0) return invalidInput(subaction, "Adding tracks needs trackUris.");
      await service.addTracksToPlaylist(ref, playlistId, uris);
      return success(subaction, `Added ${uris.length} track(s) to playlist ${playlistId}.`, {
        receipt: { operation: "playlist_add", target: playlistId, detail: uris.join(",") },
      });
    }
    case "playback_state": {
      const state = await service.getPlaybackState(ref);
      if (!state) {
        return success(subaction, "Nothing is playing on Spotify right now.", { state: null });
      }
      const trackLine = state.track ? describeTrack(state.track) : "unknown track";
      const deviceLine = state.device ? ` on ${describeDevice(state.device)}` : "";
      const summary = `${state.isPlaying ? "Playing" : "Paused"}: ${trackLine}${deviceLine}.`;
      return success(subaction, summary, { state: state as unknown as Record<string, unknown> });
    }
    case "play": {
      const deviceId = text(params.deviceId);
      const contextUri = text(params.contextUri);
      const uris = stringList(params.trackUris);
      await service.play(ref, {
        ...(deviceId !== undefined ? { deviceId } : {}),
        ...(contextUri !== undefined ? { contextUri } : {}),
        ...(uris.length > 0 ? { trackUris: uris } : {}),
      });
      return success(subaction, "Started Spotify playback.", {
        receipt: {
          operation: "play",
          target: deviceId ?? "active-device",
          detail: contextUri ?? uris.join(","),
        },
      });
    }
    case "pause": {
      await service.pause(ref, text(params.deviceId));
      return success(subaction, "Paused Spotify playback.", {
        receipt: {
          operation: "pause",
          target: text(params.deviceId) ?? "active-device",
          detail: "",
        },
      });
    }
    case "next": {
      await service.nextTrack(ref, text(params.deviceId));
      return success(subaction, "Skipped to the next track.", {
        receipt: {
          operation: "next",
          target: text(params.deviceId) ?? "active-device",
          detail: "",
        },
      });
    }
    case "previous": {
      await service.previousTrack(ref, text(params.deviceId));
      return success(subaction, "Went back to the previous track.", {
        receipt: {
          operation: "previous",
          target: text(params.deviceId) ?? "active-device",
          detail: "",
        },
      });
    }
    case "devices": {
      const devices = await service.listDevices(ref);
      const summary =
        devices.length > 0
          ? `Spotify devices:\n${devices.map((device) => `- ${describeDevice(device)}`).join("\n")}`
          : "No Spotify devices are currently available.";
      return success(subaction, summary, {
        devices: devices as unknown as Record<string, unknown>[],
      });
    }
    case "transfer": {
      const deviceId = text(params.deviceId);
      if (!deviceId) return invalidInput(subaction, "Device handoff needs a deviceId.");
      await service.transferPlayback(ref, deviceId, { play: params.play !== false });
      return success(subaction, `Transferred Spotify playback to device ${deviceId}.`, {
        receipt: { operation: "transfer", target: deviceId, detail: "" },
      });
    }
  }
}

export const spotifyAction: Action = {
  name: "SPOTIFY",
  description:
    "Control Spotify: search for music, manage the saved-track library, list/create/extend playlists, inspect and control playback, and hand playback off between devices.",
  similes: ["MUSIC", "PLAY_MUSIC", "SPOTIFY_CONTROL"],
  tags: ["domain:music", "capability:read", "capability:write", "effect:receipt-required"],
  parameters: [
    {
      name: "action",
      description: `The Spotify operation to perform. One of: ${SPOTIFY_SUBACTIONS.join(", ")}.`,
      required: true,
      schema: { type: "string", enum: [...SPOTIFY_SUBACTIONS] },
    },
    {
      name: "query",
      description: "Search text (for action=search).",
      subactions: ["search"],
      schema: { type: "string" },
    },
    {
      name: "types",
      description: "Search result types: track, album, artist, playlist (default track).",
      subactions: ["search"],
      schema: { type: "array", items: { type: "string" } },
    },
    {
      name: "trackIds",
      description: "Spotify track IDs (for library save/remove).",
      subactions: ["library_save", "library_remove"],
      schema: { type: "array", items: { type: "string" } },
    },
    {
      name: "trackUris",
      description: "Spotify track URIs (for playlist_add or play).",
      subactions: ["playlist_add", "play"],
      schema: { type: "array", items: { type: "string" } },
    },
    {
      name: "playlistId",
      description: "Target playlist ID (for playlist_add).",
      subactions: ["playlist_add"],
      schema: { type: "string" },
    },
    {
      name: "name",
      description: "Playlist name (for playlist_create).",
      subactions: ["playlist_create"],
      schema: { type: "string" },
    },
    {
      name: "description",
      description: "Playlist description (for playlist_create).",
      subactions: ["playlist_create"],
      schema: { type: "string" },
    },
    {
      name: "public",
      description: "Whether the created playlist is public (default false).",
      subactions: ["playlist_create"],
      schema: { type: "boolean" },
    },
    {
      name: "contextUri",
      description: "Album/playlist/artist URI to play (for play).",
      subactions: ["play"],
      schema: { type: "string" },
    },
    {
      name: "deviceId",
      description: "Target device ID (for playback control and transfer).",
      subactions: ["play", "pause", "next", "previous", "transfer"],
      schema: { type: "string" },
    },
    {
      name: "play",
      description: "Whether playback starts on the target device after transfer (default true).",
      subactions: ["transfer"],
      schema: { type: "boolean" },
    },
    {
      name: "limit",
      description: "Page size for list operations.",
      schema: { type: "number" },
    },
    {
      name: "offset",
      description: "Page offset for list operations.",
      schema: { type: "number" },
    },
    {
      name: "accountId",
      description: "Connected Spotify account id (defaults to the first connected account).",
      schema: { type: "string" },
    },
  ],
  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    return Boolean(runtime.getService(SPOTIFY_SERVICE_NAME));
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions | Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const params = parameters(message, options);
    const subaction = normalizeSubaction(params.action);
    if (!subaction) {
      const reason = `Spotify needs an action parameter. One of: ${SPOTIFY_SUBACTIONS.join(", ")}.`;
      return {
        success: false,
        text: reason,
        userFacingText: reason,
        verifiedUserFacing: true,
        data: { actionName: "SPOTIFY", reason: "invalid_input" },
      };
    }
    let result: ActionResult;
    try {
      result = await execute(runtime, subaction, params);
    } catch (error) {
      // error-policy:J1 the action boundary returns a structured failure the
      // planner can act on; unexpected programming failures keep throwing.
      if (!(error instanceof ElizaError)) throw error;
      result = failureFromError(subaction, error);
    }
    await callback?.({ text: result.userFacingText ?? result.text, actions: ["SPOTIFY"] });
    return result;
  },
};

export const spotifyActions = [spotifyAction];
