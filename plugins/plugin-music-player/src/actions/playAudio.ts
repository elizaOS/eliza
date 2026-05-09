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
import { MUSIC_PLAYER_ACTION_DOCS } from "../prompts/musicPlayerInstructions";
import { MusicService } from "../service";
import { isPlaybackTransportControlOnlyMessage } from "../utils/playbackTransportIntent";
import { ProgressiveMessage } from "../utils/progressiveMessage";
import {
  confirmationRequired,
  isConfirmed,
  mergedOptions,
} from "./confirmation";

// Local stubs for cross-plugin / native deps that ship without d.ts files.
// `@elizaos/plugin-music-library` builds with `dts: false`, and `discord.js`
// is an optional peer dep we don't want to take a hard type dependency on.
interface DetectedMusicEntity {
  confidence: number;
  name: string;
  type: "song" | "artist" | "album" | string;
}

interface LibraryTrack {
  url: string;
  title: string;
  duration?: number;
  playCount?: number;
}

interface SpotifyTrackInfo {
  name?: string;
  artists?: { name: string }[];
}

interface SpotifyClientLike {
  isConfigured?: () => boolean;
  getTrack?: (trackId: string) => Promise<SpotifyTrackInfo | null>;
}

interface MusicLibraryLookupService {
  addSong?(song: {
    url: string;
    title: string;
    duration?: number;
    requestedBy?: string;
  }): Promise<unknown>;
  detectEntities?(text: string): Promise<DetectedMusicEntity[] | null>;
  getLastPlayedSong?(): Promise<LibraryTrack | null>;
  getSong?(url: string): Promise<LibraryTrack | null>;
  getSongByUrl?(url: string): Promise<LibraryTrack | null>;
  searchLibrary?(query: string, limit?: number): Promise<LibraryTrack[]>;
  searchYouTube?(
    query: string,
    options?: { limit?: number; includeShorts?: boolean },
  ): Promise<
    Array<{
      url: string;
      title: string;
      duration?: number;
      channel?: string;
      views?: number;
    }>
  >;
  spotifyClient?: SpotifyClientLike;
  trackTrackRequest?(
    entityId: string,
    track: { url: string; title: string },
    roomId?: string,
    worldId?: string,
  ): Promise<void>;
}

interface BaseGuildVoiceChannel {
  guild: { members?: { me?: { voice?: { channel: unknown } } } };
  members?: Map<string, { voice?: { channel: unknown } }>;
}

// Discord service name constant
const DISCORD_SERVICE_NAME = "discord";

// Type definitions for Discord service (minimal interface to avoid direct dependency)
interface DiscordService {
  client: any;
  voiceManager?: VoiceManager;
}

function isDiscordService(service: unknown): service is DiscordService {
  return typeof service === "object" && service !== null && "client" in service;
}

interface VoiceManager {
  getVoiceConnection(guildId: string): any;
  joinChannel(channel: BaseGuildVoiceChannel): Promise<void>;
  playAudio(
    audioStream: any,
    options?: {
      guildId?: string;
      channel?: number;
      interrupt?: boolean;
      signal?: AbortSignal;
      mix?: boolean;
    },
  ): Promise<any>;
  on(event: "registerChannel", listener: (config: any) => void): void;
  emit(event: "registerChannel", config: any): boolean;
}

type PlayAudioOptions = Record<string, unknown> | undefined;
type ActionResultData = NonNullable<ActionResult["data"]>;

function getPlayAudioQuery(message: Memory, options: PlayAudioOptions): string {
  const merged = mergedOptions(options);
  const explicitQuery =
    typeof merged.query === "string" && merged.query.trim().length > 0
      ? merged.query.trim()
      : typeof merged.url === "string" && merged.url.trim().length > 0
        ? merged.url.trim()
        : "";
  return explicitQuery || message.content.text || "";
}

function failureResult(
  text: string,
  error: string,
  data?: ActionResultData,
): ActionResult {
  return { success: false, text, error, data };
}

const PLAY_AUDIO_CONTEXTS = ["media", "automation"] as const;
const PLAY_AUDIO_KEYWORDS = [
  "play",
  "song",
  "track",
  "music",
  "audio",
  "queue",
  "youtube",
  "spotify",
  "soundcloud",
  "stream",
  "listen",
  "reproduce",
  "cancion",
  "musica",
  "escuchar",
  "jouer",
  "chanson",
  "musique",
  "écouter",
  "spielen",
  "lied",
  "musik",
  "ascolta",
  "riproduci",
  "canzone",
  "再生",
  "曲",
  "音楽",
  "播放",
  "歌曲",
  "音乐",
  "재생",
  "노래",
  "음악",
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

function hasPlayAudioIntent(
  message: Memory,
  state: State | undefined,
): boolean {
  const text = [
    typeof message.content?.text === "string" ? message.content.text : "",
    typeof state?.values?.recentMessages === "string"
      ? state.values.recentMessages
      : "",
  ]
    .join("\n")
    .toLowerCase();
  if (extractAudioUrl(text).url) return true;
  return PLAY_AUDIO_KEYWORDS.some((keyword) =>
    text.includes(keyword.toLowerCase()),
  );
}

/**
 * Extract Spotify track/album/playlist info from URL
 * Returns search query that can be used to find the track on YouTube
 */
const extractSpotifyInfo = (
  spotifyUrl: string,
): { type: "track" | "album" | "playlist"; searchQuery: string } | null => {
  try {
    const url = new URL(spotifyUrl);
    const pathParts = url.pathname.split("/").filter((p) => p);

    if (pathParts.length < 2) return null;

    const type = pathParts[0] as "track" | "album" | "playlist";
    const id = pathParts[1];

    if (!["track", "album", "playlist"].includes(type) || !id) return null;

    // For Spotify URLs, we'll need to convert to a search query
    // The actual track info will be fetched via Spotify API if available
    return { type, searchQuery: spotifyUrl }; // Return URL as search query for now
  } catch {
    return null;
  }
};

/**
 * Extract supported audio URL from the message text using regex
 * Supports:
 * - YouTube: various formats (youtube.com, youtu.be)
 * - SoundCloud: soundcloud.com URLs
 * - Spotify: open.spotify.com URLs (converted to search queries)
 * - All yt-dlp supported platforms: Twitch, Vimeo, Bandcamp, Mixcloud, TikTok, Twitter/X, Instagram, etc.
 */
const extractAudioUrl = (
  messageText: string,
): {
  url: string | null;
  isSpotify: boolean;
  spotifyInfo?: { type: string; searchQuery: string };
} => {
  if (!messageText) return { url: null, isSpotify: false };

  // YouTube URL patterns
  const youtubeRegex =
    /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  const youtubeMatch = messageText.match(youtubeRegex);
  if (youtubeMatch?.[1]) {
    return {
      url: `https://www.youtube.com/watch?v=${youtubeMatch[1]}`,
      isSpotify: false,
    };
  }

  // Spotify URL patterns (needs special handling - convert to search)
  const spotifyRegex =
    /(?:https?:\/\/)?(?:open\.)?spotify\.com\/(?:track|album|playlist)\/[a-zA-Z0-9]+(?:\?[^\s]*)?/i;
  const spotifyMatch = messageText.match(spotifyRegex);
  if (spotifyMatch) {
    let url = spotifyMatch[0];
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = `https://${url}`;
    }
    const spotifyInfo = extractSpotifyInfo(url);
    return {
      url: null,
      isSpotify: true,
      spotifyInfo: spotifyInfo || undefined,
    };
  }

  // Generic URL pattern for other platforms
  // yt-dlp supports 1000+ sites, so we're permissive - if it looks like a valid URL,
  // we'll pass it to yt-dlp and let it try to extract it
  const genericUrlRegex =
    /https?:\/\/(?:www\.)?(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?:\/[^\s]*)?/i;
  const genericMatch = messageText.match(genericUrlRegex);
  if (genericMatch) {
    const url = genericMatch[0];
    try {
      const parsedUrl = new URL(url);
      const domain = parsedUrl.hostname.toLowerCase().replace(/^www\./, "");

      // Exclude known non-media domains (email, file protocols, etc.)
      const excludedDomains = [
        "mailto:",
        "file:",
        "data:",
        "javascript:",
        "gmail.com",
        "outlook.com",
        "yahoo.com", // Email providers
      ];

      // If it's a valid HTTP/HTTPS URL and not excluded, pass it to yt-dlp
      // yt-dlp is very permissive and will attempt extraction from most URLs
      if (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") {
        if (!excludedDomains.some((excluded) => domain.includes(excluded))) {
          return { url, isSpotify: false };
        }
      }
    } catch {
      // Invalid URL, ignore
    }
  }

  return { url: null, isSpotify: false };
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeQuotes = (value: string): string =>
  value.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();

const SEARCH_FILLER_TOKENS = [
  "dj",
  "djynai",
  "ai",
  "please",
  "pls",
  "plz",
  "thanks",
  "thankyou",
  "song",
  "track",
  "music",
  "video",
  "play",
  "queue",
  "add",
];

const stripFillerTokens = (query: string): string => {
  const tokens = query
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const filtered = tokens.filter(
    (token) => !SEARCH_FILLER_TOKENS.includes(token.toLowerCase()),
  );

  if (filtered.length >= 2) {
    return filtered.join(" ");
  }

  return tokens.join(" ");
};

const dedupeStrings = (values: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.toLowerCase();
    if (normalized.length === 0) {
      continue;
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(value);
    }
  }
  return result;
};

const buildQueryFromEntities = (
  entities: DetectedMusicEntity[],
  fallback: string,
): string => {
  if (!entities || entities.length === 0) {
    return fallback;
  }

  const sorted = [...entities].sort((a, b) => b.confidence - a.confidence);
  const songs = sorted.filter((entity) => entity.type === "song");
  const artists = sorted.filter((entity) => entity.type === "artist");
  const albums = sorted.filter((entity) => entity.type === "album");

  const candidateParts: string[] = [];
  if (songs[0]) {
    candidateParts.push(songs[0].name);
  }
  if (artists[0]) {
    candidateParts.push(artists[0].name);
  } else if (!songs[0] && albums[0]) {
    candidateParts.push(albums[0].name);
  }

  const combined = dedupeStrings(candidateParts).join(" ").trim();
  if (combined.length >= 3) {
    return combined;
  }

  const topNames = dedupeStrings(sorted.map((entity) => entity.name))
    .slice(0, 3)
    .join(" ")
    .trim();
  if (topNames.length >= 3) {
    return topNames;
  }

  return fallback;
};

const enhanceSearchQuery = async (
  runtime: IAgentRuntime,
  baseQuery: string,
  originalText: string,
): Promise<string> => {
  let refined = normalizeQuotes(baseQuery);
  refined = stripFillerTokens(refined);

  try {
    const musicLibrary = runtime.getService(
      "musicLibrary",
    ) as MusicLibraryLookupService | null;
    if (musicLibrary?.detectEntities) {
      const detectionSource = originalText || baseQuery;
      const entities = await musicLibrary.detectEntities(detectionSource);
      if (entities && entities.length > 0) {
        const entityQuery = buildQueryFromEntities(entities, refined);
        if (entityQuery && entityQuery.length >= 3) {
          refined = entityQuery;
        }
      }
    }
  } catch (error) {
    logger.debug(
      `Music entity detection unavailable for query refinement: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return refined;
};

/**
 * Check if the message is a pronoun reference (it, that, this, etc.)
 */
const isPronounReference = (messageText: string): boolean => {
  if (!messageText) return false;

  const text = messageText.toLowerCase().trim();

  // Common pronoun patterns
  const pronounPatterns = [
    /^(?:play|queue|add)\s+(?:it|that|this)(?:\s+song|\s+one|\s+track)?$/i,
    /^(?:it|that|this)$/i,
    /^(?:that\s+song|this\s+song|that\s+one|this\s+one)$/i,
    /^(?:play|queue)\s+(?:the\s+)?(?:last|previous|recent)\s+(?:song|one|track)$/i,
  ];

  return pronounPatterns.some((pattern) => pattern.test(text));
};

/**
 * Extract search query from message text for playing music
 * Handles various natural language patterns
 */
const extractSearchQuery = (
  messageText: string,
  botName?: string,
): string | null => {
  if (!messageText) return null;

  // Remove common play/queue prefixes
  let query = messageText.trim();

  // Remove bot name if present ANYWHERE (case insensitive, allow punctuation)
  // Use global flag to remove all occurrences
  if (botName) {
    const escapedName = escapeRegExp(botName);
    // Match bot name with optional @, followed by optional punctuation/whitespace
    const botNamePattern = new RegExp(`@?${escapedName}[\\s,:-]*`, "gi");
    query = query.replace(botNamePattern, "").trim();
  }

  // Patterns to remove (case insensitive) - order matters!
  // Using ^ anchor for start-of-string patterns
  const prefixPatterns = [
    // Greetings
    /^(?:hey|hi|yo|alright|okay|ok)[,\s]+/i,
    // Politeness
    /^(?:please|pls|plz)[,\s]+/i,
    // Modal verbs / requests
    /^(?:can you|could you|would you|will you|can|could|would|will)[,\s]+/i,
    // Additional conversational phrases
    /^(?:go ahead and|i want to hear|i want|i wanna hear|i wanna|let's hear|let me hear|throw on|cue up|find and)[,\s]+/i,
    // Action verbs with optional articles/words - be more aggressive
    /^(?:play|queue|add|put on|start|begin|load|search for|search|find|get|show me|give me)[,\s]+(?:me\s+)?(?:the\s+)?(?:song|track|music|video|audio)?[,\s]*/i,
    // Clean up any remaining common words at start
    /^(?:me|the|a|an|some)[,\s]+/i,
  ];

  // Apply each pattern multiple times until no more matches
  for (const pattern of prefixPatterns) {
    let prevQuery = "";
    while (prevQuery !== query) {
      prevQuery = query;
      query = query.replace(pattern, "").trim();
    }
  }

  // Remove any leading/trailing commas or punctuation
  query = query.replace(/^[,\s:-]+|[,\s:-]+$/g, "").trim();

  // Require minimum 3 characters to avoid ambiguous searches
  if (query.length < 3) {
    return null;
  }

  return stripFillerTokens(query);
};

/**
 * Get the current voice channel the bot is in, or the user's voice channel
 */
const getCurrentVoiceChannel = async (
  discordService: DiscordService,
  guildId: string,
  userId?: string,
): Promise<BaseGuildVoiceChannel | null> => {
  if (!discordService.client) return null;

  try {
    const guild = await discordService.client.guilds.fetch(guildId);
    if (!guild) return null;

    // First, check if the bot is in a voice channel
    const botMember = guild.members.me;
    if (botMember?.voice?.channel) {
      return botMember.voice.channel as BaseGuildVoiceChannel;
    }

    // If not, check if the user is in a voice channel
    if (userId) {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member?.voice?.channel) {
        return member.voice.channel as BaseGuildVoiceChannel;
      }
    }

    return null;
  } catch (error) {
    logger.error(
      "Error getting current voice channel:",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
};

export const playAudio: Action = {
  name: "PLAY_AUDIO",
  contexts: ["media", "automation"],
  contextGate: { anyOf: ["media", "automation"] },
  roleGate: { minRole: "USER" },
  similes: [
    "PLAY_YOUTUBE",
    "PLAY_YOUTUBE_AUDIO",
    "PLAY_VIDEO_AUDIO",
    "PLAY_MUSIC",
    "PLAY_SONG",
    "PLAY_TRACK",
    "START_MUSIC",
    "PLAY_THIS",
    "STREAM_YOUTUBE",
    "PLAY_FROM_YOUTUBE",
    "QUEUE_SONG",
    "ADD_TO_QUEUE",
  ],
  description:
    "Start playing a new song: provide a track name, artist, search words, or a media URL. " +
    "Requires confirmed:true before playback or queue changes. " +
    "Never use PLAY_AUDIO for pause, resume, stop, skip, or queue — those go through PLAYBACK_OP " +
    "with op=pause|resume|skip|stop|queue. Do not pass action=pause or similar params to PLAY_AUDIO. " +
    MUSIC_PLAYER_ACTION_DOCS,
  descriptionCompressed:
    "Play new song by name/artist/URL. Not for pause/resume/stop/skip.",
  parameters: [
    {
      name: "query",
      description:
        "Track name, artist, search phrase, or direct media URL to play.",
      required: false,
      schema: { type: "string", minLength: 3 },
    },
    {
      name: "url",
      description:
        "Direct media URL to play. Prefer query for standard song requests.",
      required: false,
      schema: { type: "string", minLength: 8 },
    },
    {
      name: "confirmed",
      description: "Must be true to play or queue the requested audio.",
      required: false,
      schema: { type: "boolean", default: false },
    },
  ],
  validate: async (_runtime: IAgentRuntime, message: Memory, state: State) => {
    const text = message.content?.text || "";
    if (isPlaybackTransportControlOnlyMessage(text)) {
      return false;
    }
    return (
      selectedContextMatches(state, PLAY_AUDIO_CONTEXTS) ||
      hasPlayAudioIntent(message, state)
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options: Record<string, unknown> | undefined,
    callback: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const messageText = getPlayAudioQuery(message, options);
    // Create progressive message helper for status updates
    //
    // Why use ProgressiveMessage: playAudio has a deep pipeline (library check,
    // search, fetch metadata, setup voice, queue). This can take 5-15 seconds.
    // Without feedback, users think the bot is broken. ProgressiveMessage shows
    // status updates that edit the same Discord message, keeping users informed.
    const progress = new ProgressiveMessage(
      callback,
      message.content.source || "discord",
    );

    const isDiscord = message.content.source === "discord";
    const maybeDiscordService = isDiscord
      ? runtime.getService(DISCORD_SERVICE_NAME)
      : null;
    const discordService = isDiscordService(maybeDiscordService)
      ? maybeDiscordService
      : null;

    // For Discord, we need the Discord service
    if (isDiscord && !discordService?.client) {
      logger.error("Discord service not found or not initialized");
      await progress.fail("Discord service is not available.");
      return failureResult(
        "Discord service is not available.",
        "DISCORD_SERVICE_UNAVAILABLE",
      );
    }
    if (isPlaybackTransportControlOnlyMessage(messageText)) {
      const text =
        "To pause, resume, stop, skip, or queue, use PLAYBACK_OP with op=pause|resume|skip|stop|queue — not PLAY_AUDIO.";
      await callback({
        text,
        source: message.content.source || "discord",
      });
      return failureResult(text, "Transport control is not PLAY_AUDIO", {
        query: messageText,
      });
    }

    const preview = `Confirmation required before playing or queueing audio for: "${messageText}".`;
    if (!isConfirmed(options)) {
      await callback({
        text: preview,
        source: message.content.source || "discord",
      });
      return confirmationRequired(preview, { query: messageText });
    }

    // Extract audio URL from message text using regex (YouTube, SoundCloud, Spotify, etc.)
    const urlResult = extractAudioUrl(messageText);
    let audioUrl = urlResult.url;
    let videoTitle = "Unknown Title";
    let videoDuration: number | undefined;
    let searchQuery: string | null = null;

    try {
      // Initial status update (transient - will be replaced quickly)
      //
      // Why no "important" flag: Library check is usually instant (< 100ms).
      // Showing this on web/CLI would just be noise. On Discord it's fine
      // because it gets edited away immediately.
      progress.update("🔍 Looking up track...");
      const musicLibraryLookup = runtime.getService(
        "musicLibrary",
      ) as MusicLibraryLookupService | null;

      // Lazy-load play-dl for video info
      const play = await import("@vookav2/play-dl").then((m) => m.default || m);

      // Handle Spotify URLs - convert to YouTube search
      if (urlResult.isSpotify && urlResult.spotifyInfo) {
        try {
          // Try to get track info from Spotify API if available
          const musicLibrary = runtime.getService(
            "musicLibrary",
          ) as MusicLibraryLookupService | null;
          let spotifyTrackInfo: SpotifyTrackInfo | null = null;

          if (musicLibrary?.spotifyClient) {
            const spotifyClient = musicLibrary.spotifyClient;
            if (spotifyClient.isConfigured?.()) {
              const spotifyUrl = urlResult.spotifyInfo.searchQuery;
              if (urlResult.spotifyInfo.type === "track") {
                const trackId = spotifyUrl.match(/track\/([a-zA-Z0-9]+)/)?.[1];
                if (trackId && spotifyClient.getTrack) {
                  spotifyTrackInfo = await spotifyClient
                    .getTrack(trackId)
                    .catch(() => null);
                }
              }
            }
          }

          // Build search query from Spotify track info or use URL
          if (spotifyTrackInfo?.name) {
            const artistNames =
              spotifyTrackInfo.artists?.map((a) => a.name).join(" ") || "";
            searchQuery = `${artistNames} ${spotifyTrackInfo.name}`.trim();
            videoTitle = spotifyTrackInfo.name;
            logger.info(
              `Spotify track detected: ${videoTitle} - searching YouTube...`,
            );
          } else {
            // Fallback: extract from URL or use generic search
            searchQuery = `spotify:${urlResult.spotifyInfo.type}`;
            logger.info(
              `Spotify ${urlResult.spotifyInfo.type} detected - will search YouTube for similar content`,
            );
          }

          // Set audioUrl to null so we trigger YouTube search
          audioUrl = null;
        } catch (error) {
          logger.debug(`Error processing Spotify URL: ${error}`);
          // Fallback to YouTube search
          searchQuery = "spotify track";
          audioUrl = null;
        }
      }

      // If no URL found, try to search for the content
      if (!audioUrl) {
        // Check if this is a pronoun reference (it, that, this, etc.)
        if (isPronounReference(messageText)) {
          // Try to get the last played song from music library (if available)
          try {
            const musicLibrary = runtime.getService(
              "musicLibrary",
            ) as MusicLibraryLookupService | null;
            if (musicLibrary?.getLastPlayedSong) {
              const lastSong = await musicLibrary.getLastPlayedSong();
              if (lastSong) {
                logger.info(
                  `Pronoun reference detected, using last played song: ${lastSong.title}`,
                );
                audioUrl = lastSong.url;
                videoTitle = lastSong.title;
                videoDuration = lastSong.duration;
                searchQuery = `(reference: ${lastSong.title})`; // Mark as reference
              }
            }
          } catch (error) {
            logger.debug(
              `Music library not available for pronoun resolution: ${error}`,
            );
          }

          if (!audioUrl) {
            await progress.fail(
              "I couldn't find what song you're referring to. No songs have been played recently. Please specify the song name or provide a link.",
            );
            return failureResult(
              "I couldn't find what song you're referring to. No songs have been played recently. Please specify the song name or provide a link.",
              "NO_RECENT_TRACK_REFERENCE",
              { query: messageText },
            );
          }
        } else {
          // Extract bot name from runtime for filtering
          const botName = runtime.character.name;
          searchQuery = extractSearchQuery(messageText, botName);

          if (!searchQuery) {
            await progress.fail(
              "I couldn't understand what you want me to play. Please provide a link or tell me what song to search for (at least 3 characters).",
            );
            return failureResult(
              "I couldn't understand what you want me to play. Please provide a link or tell me what song to search for (at least 3 characters).",
              "UNPARSEABLE_PLAY_REQUEST",
              { query: messageText },
            );
          }
        }
      }

      if (!audioUrl && searchQuery) {
        searchQuery = await enhanceSearchQuery(
          runtime,
          searchQuery,
          messageText,
        );
      }

      // Track whether we found the song in the local library
      let foundInLibrary = false;

      // Only search if we don't already have a URL (from pronoun reference)
      if (!audioUrl && searchQuery) {
        // Step 1: Check local music library first
        try {
          const musicLibrary = runtime.getService(
            "musicLibrary",
          ) as MusicLibraryLookupService | null;
          if (musicLibrary?.searchLibrary) {
            logger.debug(`Searching local music library for: ${searchQuery}`);
            const libraryResults = await musicLibrary.searchLibrary(
              searchQuery,
              5,
            );

            if (libraryResults && libraryResults.length > 0) {
              // Found in library! Use the top result (sorted by play count)
              const topLibraryResult = libraryResults[0];
              audioUrl = topLibraryResult.url;
              videoTitle = topLibraryResult.title;
              videoDuration = topLibraryResult.duration;
              foundInLibrary = true;

              logger.info(
                `Found in library (${topLibraryResult.playCount} plays): ${videoTitle} at ${audioUrl}`,
              );
            } else {
              logger.debug(`No matches in library for: ${searchQuery}`);
            }
          }
        } catch (error) {
          logger.debug(`Music library search unavailable: ${error}`);
          // Continue to YouTube search if library search fails
        }

        // Step 2: If not found in library, search for track
        if (!audioUrl) {
          // Important update - show on all platforms since search can take a while
          //
          // Why "important: true": YouTube/web search takes 2-10 seconds. Without
          // feedback, users think the bot froze. Even on web/CLI where we can't
          // edit, this is worth showing as a new message so users know we're working.
          progress.update("🔍 Searching for track...", { important: true });
          logger.debug(`Searching for: ${searchQuery}`);

          try {
            const searchResults = await musicLibraryLookup?.searchYouTube?.(
              searchQuery,
              { limit: 3 },
            );

            if (!searchResults || searchResults.length === 0) {
              await progress.fail(
                `I couldn't find any results for "${searchQuery}". Try being more specific or providing a direct link.`,
              );
              return failureResult(
                `I couldn't find any results for "${searchQuery}". Try being more specific or providing a direct link.`,
                "NO_SEARCH_RESULTS",
                { searchQuery },
              );
            }

            // Use first result
            const topResult = searchResults[0];
            audioUrl = topResult.url;
            videoTitle = topResult.title;
            videoDuration = topResult.duration;

            logger.info(`Found on YouTube: ${videoTitle} at ${audioUrl}`);
          } catch (error) {
            logger.error(
              "Error searching YouTube:",
              error instanceof Error ? error.message : String(error),
            );
            const errorMsg =
              error instanceof Error ? error.message : String(error);
            await progress.fail(
              `I had trouble searching for "${searchQuery}". ${
                errorMsg.includes("browseEndpoint") ||
                errorMsg.includes("navigationEndpoint")
                  ? "Try being more specific with song and artist names."
                  : "Please try again or provide a direct link."
              }`,
            );
            return failureResult(
              `I had trouble searching for "${searchQuery}". ${
                errorMsg.includes("browseEndpoint") ||
                errorMsg.includes("navigationEndpoint")
                  ? "Try being more specific with song and artist names."
                  : "Please try again or provide a direct link."
              }`,
              errorMsg,
              { searchQuery },
            );
          }
        }
      }

      // For URL-based requests, get video/track info
      if (audioUrl && !videoDuration) {
        // First, check if we have this URL in our music library
        try {
          const musicLibrary = runtime.getService(
            "musicLibrary",
          ) as MusicLibraryLookupService | null;
          const getSongByUrl =
            musicLibrary?.getSongByUrl ?? musicLibrary?.getSong;
          if (musicLibrary && getSongByUrl) {
            logger.debug(`Checking library for URL: ${audioUrl}`);
            const libraryTrack = await getSongByUrl.call(
              musicLibrary,
              audioUrl,
            );

            if (libraryTrack) {
              // Found in library! Use cached info
              videoTitle = libraryTrack.title;
              videoDuration = libraryTrack.duration;
              foundInLibrary = true;
              logger.info(
                `Found URL in library (${libraryTrack.playCount || 0} plays): ${videoTitle}`,
              );
            }
          }
        } catch (error) {
          logger.debug(`Music library lookup by URL unavailable: ${error}`);
          // Continue to fetch video info if library lookup fails
        }

        // Only fetch video info if we didn't find it in the library
        if (!videoDuration) {
          // Check if it's a YouTube URL (play-dl only supports YouTube)
          const isYouTube =
            audioUrl.includes("youtube.com") || audioUrl.includes("youtu.be");

          if (isYouTube) {
            // Validate YouTube URL
            if (!play.yt_validate(audioUrl)) {
              await progress.fail("The provided URL is not valid.");
              return failureResult(
                "The provided URL is not valid.",
                "INVALID_URL",
                {
                  audioUrl,
                },
              );
            }

            // Get video info for YouTube URLs
            const videoInfo = await play.video_info(audioUrl).catch((error) => {
              logger.error(
                "Error getting YouTube video info:",
                error instanceof Error ? error.message : String(error),
              );
              return null;
            });

            if (!videoInfo) {
              await progress.fail(
                "I could not access that content. It may be private, unavailable, or the URL may be invalid.",
              );
              return failureResult(
                "I could not access that content. It may be private, unavailable, or the URL may be invalid.",
                "INACCESSIBLE_MEDIA",
                { audioUrl },
              );
            }

            videoTitle = videoInfo.video_details.title || "Unknown Title";
            videoDuration = videoInfo.video_details.durationInSec;
          } else {
            // For SoundCloud and other platforms, yt-dlp will handle it
            // We can try to extract title from URL or use a generic title
            // The actual title will be determined when the track is played
            const urlParts = audioUrl.split("/");
            const lastPart = urlParts[urlParts.length - 1];
            videoTitle = lastPart
              ? decodeURIComponent(lastPart.replace(/[-_]/g, " "))
              : "Unknown Title";
            logger.info(`Using URL for non-YouTube platform: ${audioUrl}`);
          }
        }
      }

      const room = state.data?.room || (await runtime.getRoom(message.roomId));
      let currentServerId = room?.serverId;

      // For non-Discord platforms, create a deterministic server ID
      if (!currentServerId) {
        if (isDiscord) {
          await progress.fail("I could not determine which server you are in.");
          return failureResult(
            "I could not determine which server you are in.",
            "DISCORD_SERVER_UNRESOLVED",
          );
        } else {
          // For web/CLI, use room ID as server ID
          currentServerId = `web-${message.roomId}`;
        }
      } else if (!isDiscord) {
        // Prefix with 'web-' for non-Discord platforms to avoid conflicts with Discord server IDs
        currentServerId = `web-${currentServerId}`;
      }
      // For Discord, use the server ID as-is (no prefix)

      // Use entityId (UUID) not fromId (Discord snowflake) for requestedBy
      // WHY: fromId in metadata is the raw Discord snowflake ID for security reference
      // entityId is the proper UUID created by createUniqueUuid(runtime, discordId)
      const requestUserId = message.entityId;

      // Discord-specific voice channel logic
      // For Discord, use the original server ID (without web- prefix)
      const discordServerId = isDiscord
        ? room?.serverId || currentServerId
        : null;
      let voiceManager: VoiceManager | null = null;
      if (isDiscord && discordService && discordServerId) {
        // Get current voice channel
        let voiceChannel = await getCurrentVoiceChannel(
          discordService,
          discordServerId,
          requestUserId,
        );

        // If bot is not in a voice channel, try to join the user's voice channel
        if (!voiceChannel && requestUserId) {
          const guild =
            await discordService.client.guilds.fetch(discordServerId);
          const member = await guild.members
            .fetch(requestUserId)
            .catch(() => null);
          if (member?.voice?.channel) {
            voiceChannel = member.voice.channel as BaseGuildVoiceChannel;
            voiceManager = discordService.voiceManager as VoiceManager;
            if (voiceManager) {
              await voiceManager.joinChannel(voiceChannel);
            }
          }
        }

        if (!voiceChannel) {
          await progress.fail(
            "I'm not in a voice channel, and you don't appear to be in one either. Please join a voice channel first, or ask me to join one.",
          );
          return failureResult(
            "I'm not in a voice channel, and you don't appear to be in one either. Please join a voice channel first, or ask me to join one.",
            "VOICE_CHANNEL_REQUIRED",
          );
        }

        voiceManager = discordService.voiceManager as VoiceManager;
        if (!voiceManager) {
          await progress.fail(
            "Voice functionality is not available at the moment.",
          );
          return failureResult(
            "Voice functionality is not available at the moment.",
            "VOICE_MANAGER_UNAVAILABLE",
          );
        }

        // Get voice connection
        let connection = voiceManager.getVoiceConnection(discordServerId);
        if (!connection) {
          // Try to join the voice channel
          await voiceManager.joinChannel(voiceChannel);
          // Wait a bit for connection to establish
          await new Promise((resolve) => setTimeout(resolve, 1000));
          connection = voiceManager.getVoiceConnection(discordServerId);
          if (!connection) {
            await progress.fail(
              "I could not establish a voice connection. Please try again.",
            );
            return failureResult(
              "I could not establish a voice connection. Please try again.",
              "VOICE_CONNECTION_FAILED",
            );
          }
        }

        // Register music channel (channel 1) if not already registered
        // This ensures the channel has the right configuration for music playback
        voiceManager.emit("registerChannel", {
          channel: 1,
          priority: 50,
          canPause: true,
          interruptible: true,
          volume: 1.0,
          duckVolume: 0.3,
        });
      }

      // Get or create music service
      let musicService = runtime.getService("music") as MusicService;
      if (!musicService) {
        musicService = new MusicService(runtime);
        // Note: Service registration would typically happen in plugin init
        // For now, we'll use it directly
      }

      // For Discord, ensure voice manager is set
      if (isDiscord && voiceManager) {
        musicService.setVoiceManager(voiceManager);
      }

      // Check queue state BEFORE adding track
      // This tells us if the track will start playing immediately or be queued
      const currentTrack = musicService.getCurrentTrack(currentServerId);
      const queueLength = musicService.getQueueList(currentServerId).length;
      const willPlayImmediately = !currentTrack && queueLength === 0;

      // Build response message BEFORE adding track
      let responseText: string;
      if (willPlayImmediately) {
        // Track will start playing immediately
        if (foundInLibrary) {
          responseText = `📚 Playing from your library: **${videoTitle}**`;
        } else if (searchQuery) {
          responseText = `🔎 Found and now playing: **${videoTitle}**`;
        } else {
          responseText = `Now playing: **${videoTitle}**`;
        }
      } else {
        // Track will be added to queue
        const position = queueLength + 1; // Position after adding
        if (foundInLibrary) {
          responseText = `📚 Added from your library (position ${position}): **${videoTitle}**`;
        } else if (searchQuery) {
          responseText = `🔎 Found and added to queue (position ${position}): **${videoTitle}**`;
        } else {
          responseText = `Added to queue (position ${position}): **${videoTitle}**`;
        }
      }

      // For non-Discord platforms, provide web streaming URLs
      if (!isDiscord) {
        const baseUrl = process.env.SERVER_URL || "http://localhost:3000";
        const streamUrl = `${baseUrl}/music-player/stream?guildId=${encodeURIComponent(currentServerId)}`;
        const nowPlayingUrl = `${baseUrl}/music-player/now-playing?guildId=${encodeURIComponent(currentServerId)}`;
        responseText += `\n\n🌐 Web streaming: ${streamUrl}`;
        responseText += `\n📊 Track info: ${nowPlayingUrl}`;
      }

      // Show we're setting up playback (transient - skip on non-editing platforms)
      //
      // Why no "important" flag: Voice setup and queue add are fast (< 200ms).
      // This is just "progressive polish" for Discord - not worth showing on
      // web/CLI where it would create an extra message.
      progress.update("✨ Setting up playback...");

      // Add track to queue (this may start playback immediately)
      const track = await musicService.addTrack(currentServerId, {
        url: audioUrl as string,
        title: videoTitle,
        duration: videoDuration,
        requestedBy: requestUserId,
      });

      // Send final message with track info
      logger.info(`[PLAY_AUDIO] Completing with: ${responseText}`);
      await progress.complete(responseText);
      logger.info("[PLAY_AUDIO] Progressive complete sent successfully");

      // Now do background operations (library tracking, memory creation)
      // These don't need to block the user feedback

      // Persist an action-log memory so the agent remembers what it played.
      // WHY entityId = agentId: this is the agent's action, not a user
      // message. Using message.entityId (the user) made it appear as a
      // blank user bubble in the web chat because the content has
      // `thought` but no `text`.
      runtime
        .createMemory(
          {
            entityId: runtime.agentId,
            agentId: message.agentId,
            roomId: message.roomId,
            content: {
              source: "action",
              thought: searchQuery
                ? `Searched for "${searchQuery}" and playing: ${videoTitle}`
                : `Playing audio: ${videoTitle}`,
              actions: ["PLAY_AUDIO"],
            },
            metadata: {
              type: "custom" as const,
              kind: "PLAY_AUDIO",
              audioUrl: audioUrl,
              videoTitle,
              trackId: track.id,
              ...(searchQuery && { searchQuery }),
            },
          },
          "messages",
        )
        .catch((error) => logger.warn(`Failed to create memory: ${error}`));

      // Track the request in user preferences (background)
      try {
        const musicLibrary = runtime.getService(
          "musicLibrary",
        ) as MusicLibraryLookupService | null;
        if (musicLibrary?.trackTrackRequest) {
          musicLibrary
            .trackTrackRequest(
              message.entityId,
              {
                url: audioUrl as string,
                title: videoTitle,
              },
              message.roomId,
              message.worldId,
            )
            .catch((error: Error) =>
              logger.warn(`Failed to track request: ${error}`),
            );
        }
      } catch (error) {
        logger.warn(`Failed to track request: ${error}`);
      }

      // Save to global music library for future reference (background)
      try {
        const musicLibrary = runtime.getService(
          "musicLibrary",
        ) as MusicLibraryLookupService | null;
        logger.info(
          `[PlayAudio] Music library service: ${musicLibrary ? "found" : "NOT FOUND"}`,
        );
        if (musicLibrary?.addSong) {
          logger.info(
            `[PlayAudio] Adding to music library: "${videoTitle}" (${audioUrl})`,
          );
          musicLibrary
            .addSong({
              url: audioUrl as string,
              title: videoTitle,
              duration: videoDuration,
              requestedBy: requestUserId,
            })
            .then(() => {
              logger.info(
                `[PlayAudio] ✅ Song added to music library: "${videoTitle}"`,
              );
            })
            .catch((error: Error) => {
              logger.error(
                `[PlayAudio] ❌ Failed to add song to library: ${error.message}`,
              );
            });
        } else if (musicLibrary) {
          logger.warn(
            `[PlayAudio] Music library service found but addSong method missing. Available methods: ${Object.keys(musicLibrary).join(", ")}`,
          );
        }
      } catch (error) {
        logger.error(`[PlayAudio] Error accessing music library: ${error}`);
      }

      // Memories already created via callback, return success
      return {
        success: true,
        text: responseText,
        data: {
          query: messageText,
          searchQuery,
          audioUrl,
          videoTitle,
          videoDuration,
          foundInLibrary,
          willPlayImmediately,
          queueLengthBeforeAdd: queueLength,
          trackId: track.id,
          serverId: currentServerId,
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error("Error playing audio:", errorMessage);

      // Provide specific error messages based on the error type
      let userMessage =
        "❌ I encountered an error while trying to play that track.";

      const errorLower = errorMessage.toLowerCase();
      if (
        errorLower.includes("age") &&
        (errorLower.includes("verification") ||
          errorLower.includes("restriction") ||
          errorLower.includes("restricted"))
      ) {
        userMessage =
          "⚠️ This content requires age verification or authentication.";
      } else if (
        errorLower.includes("region") ||
        errorLower.includes("not available") ||
        errorLower.includes("unavailable")
      ) {
        userMessage =
          "⚠️ This content is not available in your region or has been removed.";
      } else if (
        errorLower.includes("private") ||
        errorLower.includes("unlisted")
      ) {
        userMessage =
          "⚠️ This content is private or unlisted and cannot be accessed.";
      } else if (
        errorLower.includes("authentication") ||
        errorLower.includes("cookies") ||
        errorLower.includes("login")
      ) {
        userMessage = "⚠️ This content requires authentication.";
      } else if (errorLower.includes("unable to access")) {
        userMessage = "⚠️ Unable to access this track.";
      }

      await progress.fail(userMessage);
      return failureResult(userMessage, errorMessage, { query: messageText });
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Play https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll play that YouTube video in the voice channel!",
          actions: ["PLAY_AUDIO"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Play Surefire by Wilderado",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll search for that song and play it!",
          actions: ["PLAY_AUDIO"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Can you play Bohemian Rhapsody?",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Finding and playing that now!",
          actions: ["PLAY_AUDIO"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Queue Never Gonna Give You Up",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll search for that and add it to the queue!",
          actions: ["PLAY_AUDIO"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "play music from youtube.com/watch?v=dQw4w9WgXcQ",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll stream that YouTube video's audio!",
          actions: ["PLAY_AUDIO"],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;

export default playAudio;
