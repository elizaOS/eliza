import {
  type Action,
  type ActionExample,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  type State,
} from "@elizaos/core";
import type { MusicLibraryService } from "../services/musicLibraryService";
import { parseJsonObjectResponse } from "../utils/json";
import { confirmationRequired, isConfirmed } from "./confirmation";

interface MusicQueryIntent {
  needsResearch: boolean;
  queryType:
    | "first_single"
    | "latest_song"
    | "similar_artist"
    | "debut_album"
    | "popular_song"
    | "era"
    | "decade"
    | "year"
    | "genre"
    | "mood"
    | "vibe"
    | "activity"
    | "workout"
    | "study"
    | "party"
    | "chill"
    | "chart"
    | "top_hits"
    | "trending"
    | "album"
    | "album_track"
    | "full_album"
    | "movie_soundtrack"
    | "game_soundtrack"
    | "tv_theme"
    | "lyrics_based"
    | "topic"
    | "cover"
    | "remix"
    | "acoustic"
    | "live"
    | "specific_track"
    | "nth_album"
    | "direct_search";
  artist?: string;
  album?: string;
  song?: string;
  genre?: string;
  mood?: string;
  decade?: string;
  year?: string;
  keywords?: string;
  searchQuery?: string;
  modifier?: "cover" | "remix" | "acoustic" | "live" | "instrumental";
}

interface SearchResultSnippet {
  description?: string;
  snippet?: string;
}

interface WebSearchService {
  search(query: string): Promise<SearchResultSnippet[]>;
}

interface MusicQueueService {
  addTrack(
    guildId: string,
    track: {
      url: string;
      title: string;
      duration?: number;
      requestedBy: Memory["entityId"];
    },
  ): Promise<void>;
}

function getModelText(response: unknown): string | null {
  return typeof response === "string" ? response : null;
}

function summarizeSearchResults(results: SearchResultSnippet[]): string {
  return results
    .slice(0, 3)
    .map((result) => result.description || result.snippet || "")
    .join("\n");
}

function formatPromptValue(value: unknown, depth = 0): string {
  if (value == null) return "";
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .filter((item) => item != null)
      .slice(0, 20)
      .map((item) => {
        const rendered = formatPromptValue(item, depth + 1);
        return rendered ? `${"  ".repeat(depth)}- ${rendered}` : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry != null && entry !== "")
      .slice(0, 20)
      .map(([key, entry]) => {
        const rendered = formatPromptValue(entry, depth + 1);
        if (!rendered) return "";
        if (rendered.includes("\n")) {
          return `${"  ".repeat(depth)}${key}:\n${rendered}`;
        }
        return `${"  ".repeat(depth)}${key}: ${rendered}`;
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(value);
}

/**
 * Use LLM to understand the user's music query intent
 */
const analyzeMusicQuery = async (
  runtime: IAgentRuntime,
  messageText: string,
): Promise<MusicQueryIntent | null> => {
  try {
    const prompt = `Analyze this music-related request and extract the intent. Be comprehensive - this could be any type of music query.

Message: "${messageText}"

Determine:
1. Does this need research (Wikipedia/music databases) or can it be directly searched on YouTube?
2. What type of query is this? Choose from:
   
   ARTIST-SPECIFIC:
   - "first_single": First/debut single of an artist
   - "latest_song": Most recent song
   - "similar_artist": Similar/related artists
   - "debut_album": Songs from debut album
   - "popular_song": Popular/hit song from artist
   - "nth_album": Specific album by number (2nd album, third album, etc)
   
   TEMPORAL:
   - "era": Music from an era (80s, 90s, 2000s, etc)
   - "decade": Music from a decade
   - "year": Music from a specific year
   
   GENRE/MOOD/VIBE:
   - "genre": Specific genre (jazz, rock, hip hop, etc)
   - "mood": Mood-based (sad, happy, angry, etc)
   - "vibe": Vibe-based (chill, energetic, dark, uplifting, etc)
   
   ACTIVITY:
   - "activity": General activity music
   - "workout": Workout/gym music
   - "study": Study/focus music
   - "party": Party music
   - "chill": Chill/relaxing music
   
   CHARTS/POPULARITY:
   - "chart": Chart hits (Billboard, etc)
   - "top_hits": Top hits
   - "trending": Viral/trending songs
   
   ALBUM:
   - "album": Play from an album
   - "album_track": Specific track from album
   - "full_album": Play entire album
   
   MEDIA:
   - "movie_soundtrack": From a movie
   - "game_soundtrack": From a video game
   - "tv_theme": TV show theme
   
   LYRICS/TOPIC:
   - "lyrics_based": Based on lyrics or themes
   - "topic": Songs about a topic
   
   VERSIONS:
   - "cover": Cover version
   - "remix": Remix
   - "acoustic": Acoustic version
   - "live": Live performance
   
   SPECIFIC:
   - "specific_track": Track by number (track 3, etc)
   - "direct_search": Can search directly

3. Extract relevant details:
   - artist: Artist name if mentioned
   - album: Album name if mentioned
   - song: Song name if mentioned
   - genre: Genre if mentioned
   - mood: Mood if mentioned (happy, sad, energetic, chill, etc)
   - decade: Decade if mentioned (80s, 90s, 2000s, etc)
   - year: Specific year if mentioned
   - keywords: Other important keywords
   - modifier: If asking for specific version (cover, remix, acoustic, live, instrumental)

Respond with JSON only:
{
  "needsResearch": true,
  "queryType": "direct_search",
  "artist": "artist name if mentioned",
  "album": "album name if mentioned",
  "song": "song name if mentioned",
  "genre": "genre if mentioned",
  "mood": "mood if mentioned",
  "decade": "decade if mentioned",
  "year": "year if mentioned",
  "keywords": "other important keywords",
  "modifier": "cover|remix|acoustic|live|instrumental if requested",
  "searchQuery": "query to use for direct_search"
}`;

    const rawResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });
    const response = getModelText(rawResponse);
    if (!response) {
      return null;
    }

    const parsedJson =
      parseJsonObjectResponse<Record<string, unknown>>(response);
    if (parsedJson?.queryType) {
      return {
        ...parsedJson,
        needsResearch:
          parsedJson.needsResearch === true ||
          String(parsedJson.needsResearch).toLowerCase() === "true",
      } as unknown as MusicQueryIntent;
    }

    return null;
  } catch (error) {
    logger.error(
      "Error analyzing music query:",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
};

/**
 * Research music information using Wikipedia and music services
 */
const researchMusicInfo = async (
  runtime: IAgentRuntime,
  intent: MusicQueryIntent,
): Promise<string | null> => {
  try {
    const musicLibrary = runtime.getService(
      "musicLibrary",
    ) as MusicLibraryService | null;
    const webSearchService = runtime.getService(
      "webSearch",
    ) as WebSearchService | null;

    logger.debug(
      `Researching music info: ${intent.queryType} for ${intent.artist || intent.genre || intent.mood || "query"}`,
    );

    let searchQuery: string | null = null;

    switch (intent.queryType) {
      case "first_single":
      case "debut_album": {
        if (!intent.artist) break;

        // Try to get artist info from Wikipedia
        if (musicLibrary?.getWikipediaArtistInfo) {
          const artistInfo = (await musicLibrary.getWikipediaArtistInfo(
            intent.artist,
          )) as { discography?: unknown; similarArtists?: string[] } | null;
          if (artistInfo?.discography) {
            // Use LLM to extract first single/album from discography
            const prompt = `From this artist discography, what was their first ${intent.queryType === "first_single" ? "single" : "album"}?

Discography:
${formatPromptValue(artistInfo.discography).substring(0, 2000)}

Respond with ONLY the song/album name, nothing else.`;

            const firstRelease = getModelText(
              await runtime.useModel(ModelType.TEXT_SMALL, { prompt }),
            );
            if (firstRelease) {
              searchQuery = `${intent.artist} ${firstRelease.trim()}`;
            }
          }
        }

        // Fallback: use web search
        if (!searchQuery && webSearchService) {
          const searchResults = await webSearchService.search(
            `${intent.artist} ${intent.queryType === "first_single" ? "first single debut" : "debut album first album"}`,
          );
          if (searchResults && searchResults.length > 0) {
            const prompt = `From these search results, what was ${intent.artist}'s ${intent.queryType === "first_single" ? "first single" : "debut album"}?

Results: ${summarizeSearchResults(searchResults)}

Respond with ONLY the song/album name, nothing else.`;

            const answer = getModelText(
              await runtime.useModel(ModelType.TEXT_SMALL, { prompt }),
            );
            if (answer) {
              searchQuery = `${intent.artist} ${answer.trim()}`;
            }
          }
        }
        break;
      }

      case "nth_album": {
        if (!intent.artist || !intent.keywords) break;

        // Extract album number from keywords (second, third, 2nd, 3rd, etc)
        const numberMatch = intent.keywords.match(
          /(\d+)(?:st|nd|rd|th)|second|third|fourth|fifth/i,
        );
        if (!numberMatch) break;

        if (webSearchService) {
          const searchResults = await webSearchService.search(
            `${intent.artist} ${intent.keywords} album discography`,
          );
          if (searchResults && searchResults.length > 0) {
            const prompt = `From these search results, what was ${intent.artist}'s ${intent.keywords} album?

Results: ${summarizeSearchResults(searchResults)}

Respond with ONLY the album name, nothing else.`;

            const answer = getModelText(
              await runtime.useModel(ModelType.TEXT_SMALL, { prompt }),
            );
            if (answer) {
              searchQuery = `${intent.artist} ${answer.trim()}`;
            }
          }
        }
        break;
      }

      case "similar_artist": {
        if (!intent.artist) break;

        // Try to get similar artists from Wikipedia
        if (musicLibrary?.getWikipediaArtistInfo) {
          const artistInfo = await musicLibrary.getWikipediaArtistInfo(
            intent.artist,
          );
          if (
            artistInfo?.similarArtists &&
            artistInfo.similarArtists.length > 0
          ) {
            const similar =
              artistInfo.similarArtists[
                Math.floor(Math.random() * artistInfo.similarArtists.length)
              ];
            searchQuery = `${similar} popular song`;
            logger.info(`Found similar artist: ${similar}`);
          }
        }

        // Fallback: use canonical music metadata
        if (!searchQuery && musicLibrary?.getArtistInfo) {
          const artistInfo = await musicLibrary.getArtistInfo(intent.artist);
          if (
            artistInfo?.similarArtists &&
            artistInfo.similarArtists.length > 0
          ) {
            const similar = artistInfo.similarArtists[0];
            searchQuery = `${similar} popular song`;
            logger.info(`Found similar artist: ${similar}`);
          }
        }
        break;
      }

      case "latest_song": {
        if (!intent.artist) break;
        searchQuery = `${intent.artist} latest song new ${new Date().getFullYear()}`;
        break;
      }

      case "popular_song": {
        if (!intent.artist) break;
        searchQuery = `${intent.artist} most popular song hit`;
        break;
      }

      case "movie_soundtrack":
      case "game_soundtrack":
      case "tv_theme": {
        if (!intent.keywords) break;
        const mediaType = intent.queryType
          .replace("_soundtrack", "")
          .replace("_theme", "");
        searchQuery = `${intent.keywords} ${mediaType} ${intent.queryType.includes("theme") ? "theme" : "soundtrack"}`;
        break;
      }

      case "era":
      case "decade": {
        const timeKeyword = intent.decade || intent.year || intent.keywords;
        if (!timeKeyword) break;
        const genrePrefix = intent.genre ? `${intent.genre} ` : "";
        searchQuery = `${genrePrefix}${timeKeyword} hits popular songs`;
        break;
      }

      case "genre": {
        if (!intent.genre && !intent.keywords) break;
        const genre = intent.genre || intent.keywords;
        searchQuery = `${genre} music popular`;
        break;
      }

      case "mood":
      case "vibe": {
        const mood = intent.mood || intent.keywords;
        if (!mood) break;
        searchQuery = `${mood} music songs`;
        break;
      }

      case "workout":
      case "study":
      case "party":
      case "chill":
      case "activity": {
        const activity =
          intent.queryType === "activity" ? intent.keywords : intent.queryType;
        searchQuery = `${activity} music playlist`;
        break;
      }

      case "chart":
      case "top_hits":
      case "trending": {
        const chartType = intent.keywords || intent.queryType;
        searchQuery = `${chartType} ${new Date().getFullYear()} popular songs`;
        break;
      }

      case "lyrics_based":
      case "topic": {
        if (!intent.keywords) break;
        searchQuery = `songs about ${intent.keywords}`;
        break;
      }

      case "album_track":
      case "specific_track": {
        if (!intent.album && !intent.artist) break;
        const trackInfo = intent.keywords || "";
        searchQuery =
          `${intent.artist || ""} ${intent.album || ""} ${trackInfo}`.trim();
        break;
      }

      case "full_album": {
        if (!intent.album && !intent.artist) break;
        searchQuery = `${intent.artist || ""} ${intent.album || ""} full album`;
        break;
      }
    }

    // Apply modifier if specified (cover, remix, acoustic, live)
    if (searchQuery && intent.modifier) {
      searchQuery = `${searchQuery} ${intent.modifier}`;
    }

    return searchQuery;
  } catch (error) {
    logger.error(
      "Error researching music info:",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
};

/**
 * Smart music query action that can research and play complex queries
 */
export const playMusicQuery: Action = {
  name: "PLAY_MUSIC_QUERY",
  contexts: ["media", "knowledge"],
  contextGate: { anyOf: ["media", "knowledge"] },
  roleGate: { minRole: "USER" },
  similes: [
    "SMART_PLAY",
    "RESEARCH_AND_PLAY",
    "FIND_AND_PLAY",
    "INTELLIGENT_MUSIC_SEARCH",
  ],
  description:
    "Handle any complex music query that requires understanding and research, then queue the selected track after confirmed:true. Supports: artist queries (first single, latest song, similar artists, popular songs, nth album), temporal (80s, 90s, specific years), genre/mood/vibe, activities (workout, study, party), charts/trending, albums, movie/game/TV soundtracks, lyrics/topics, versions (covers, remixes, acoustic, live), and more. Uses Wikipedia, music databases, and web search to find the right music.",
  descriptionCompressed:
    "Complex music search: artist, genre, mood, era, activity, charts, soundtracks, versions. Uses web search + databases.",
  parameters: [
    {
      name: "confirmed",
      description:
        "Must be true to resolve the music query and add the result to the queue.",
      required: false,
      schema: { type: "boolean", default: false },
    },
  ],
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    if (message.content.source !== "discord") {
      return false;
    }

    const messageText = (message.content.text || "").toLowerCase();

    // PERFORMANCE: Skip if this is a direct YouTube URL - let playYouTubeAudio handle it (much faster)
    if (
      messageText.includes("youtube.com/") ||
      messageText.includes("youtu.be/")
    ) {
      return false;
    }

    // Check if this is a complex query that needs research
    const researchKeywords = [
      // Artist-specific
      "first single",
      "debut single",
      "first song",
      "debut album",
      "first album",
      "latest song",
      "newest song",
      "recent song",
      "new song",
      "new music",
      "something like",
      "similar to",
      "sounds like",
      "reminds me of",
      "in the style of",
      "most popular",
      "biggest hit",
      "best song",
      "top song",
      "second album",
      "third album",
      "2nd album",
      "3rd album",
      "nth album",

      // Temporal
      "80s",
      "90s",
      "2000s",
      "70s",
      "60s",
      "from the",

      // Genre/Mood
      "genre:",
      "chill",
      "vibes",
      "mood",
      "upbeat",
      "sad",
      "happy",
      "energetic",

      // Activity
      "workout",
      "gym",
      "study",
      "focus",
      "party",
      "driving",
      "sleep",

      // Charts
      "top",
      "chart",
      "billboard",
      "trending",
      "viral",
      "popular now",

      // Media
      "soundtrack",
      "theme song",
      "theme from",
      "from the movie",
      "from the game",
      "from the show",
      "tv show",

      // Lyrics/Topic
      "songs about",
      "with lyrics",
      "that mentions",

      // Versions
      "cover of",
      "remix of",
      "acoustic version",
      "live version",
      "live at",
      "instrumental",

      // Album
      "from the album",
      "track",
      "entire album",
      "full album",
      "whole album",
    ];

    const needsResearch = researchKeywords.some((keyword) =>
      messageText.includes(keyword),
    );

    // Also check for pattern "play [genre/mood] music"
    const simplePatterns = [
      /play\s+(some\s+)?(jazz|rock|pop|hip hop|rap|metal|electronic|indie|folk|country|classical|blues)/i,
      /play\s+(something\s+)?(chill|upbeat|sad|happy|energetic|mellow|intense)/i,
    ];

    return (
      needsResearch ||
      simplePatterns.some((pattern) => pattern.test(messageText))
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options: Record<string, unknown> | undefined,
    callback: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const messageText = message.content.text || "";
    const preview = `Confirmation required before resolving and queueing music for: "${messageText}".`;
    if (!isConfirmed(options)) {
      await callback({
        text: preview,
        source: message.content.source,
      });
      return confirmationRequired(preview, { query: messageText });
    }

    try {
      // Step 1: Analyze the query intent
      await callback({
        text: "🔍 Let me figure out what you want...",
        source: message.content.source,
      });

      const intent = await analyzeMusicQuery(runtime, messageText);
      if (!intent) {
        await callback({
          text: "I couldn't understand your music request. Try being more specific?",
          source: message.content.source,
        });
        return;
      }

      logger.info(`Music query intent: ${JSON.stringify(intent)}`);

      let finalSearchQuery: string | null = null;

      // Step 2: Research if needed
      if (intent.needsResearch && intent.queryType !== "direct_search") {
        const researchResult = await researchMusicInfo(runtime, intent);

        if (!researchResult) {
          await callback({
            text: "I couldn't resolve that music query from the available research services. Try a more direct song, artist, or album request.",
            source: message.content.source,
          });
          return;
        }

        finalSearchQuery = researchResult;
      } else {
        // For direct searches, construct query from intent
        if (intent.searchQuery) {
          finalSearchQuery = intent.searchQuery;
        } else {
          const parts = [
            intent.artist,
            intent.song,
            intent.album,
            intent.genre,
            intent.mood,
            intent.keywords,
          ].filter(Boolean);
          finalSearchQuery = parts.length > 0 ? parts.join(" ") : messageText;

          if (intent.modifier) {
            finalSearchQuery = `${finalSearchQuery} ${intent.modifier}`;
          }
        }
      }

      if (!finalSearchQuery) {
        await callback({
          text: "I couldn't figure out what to search for. Can you rephrase your request?",
          source: message.content.source,
        });
        return;
      }

      logger.info(`Final search query: ${finalSearchQuery}`);

      // Step 3: Search YouTube for the track
      const musicLibrary = runtime.getService(
        "musicLibrary",
      ) as MusicLibraryService | null;
      if (!musicLibrary) {
        await callback({
          text: "YouTube search service is not available.",
          source: message.content.source,
        });
        return;
      }

      const results = await musicLibrary.searchYouTube(finalSearchQuery, {
        limit: 1,
      });
      if (!results || results.length === 0) {
        await callback({
          text: `I couldn't find anything matching "${finalSearchQuery}". Try being more specific?`,
          source: message.content.source,
        });
        return;
      }

      const topResult = results[0];
      logger.info(`Found: ${topResult.title} (${topResult.url})`);

      // Step 4: Queue the track via music service
      const musicService = runtime.getService(
        "music",
      ) as MusicQueueService | null;
      if (!musicService) {
        await callback({
          text: "Music service is not available.",
          source: message.content.source,
        });
        return;
      }

      // Get Discord guild ID from room - same pattern as playAudio action
      const room = state.data?.room || (await runtime.getRoom(message.roomId));
      const guildId = room?.serverId;
      if (!guildId) {
        await callback({
          text: "Could not determine Discord server. Make sure you're messaging from a server channel.",
          source: message.content.source,
        });
        return;
      }

      // Use entityId (UUID) not fromId (Discord snowflake) for requestedBy
      // WHY: fromId in metadata is the raw Discord snowflake ID for security reference
      // entityId is the proper UUID created by createUniqueUuid(runtime, discordId)
      const requestEntityId = message.entityId;

      await musicService.addTrack(guildId, {
        url: topResult.url,
        title: topResult.title,
        duration: topResult.duration,
        requestedBy: requestEntityId,
      });

      await callback({
        text: `🎵 Queued: **${topResult.title}**`,
        source: message.content.source,
      });
      return { success: true, text: `Queued: ${topResult.title}` };
    } catch (error) {
      logger.error(
        "Error in playMusicQuery:",
        error instanceof Error ? error.message : String(error),
      );
      await callback({
        text: "I ran into an issue trying to find that music.",
        source: message.content.source,
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Play the strokes first single",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Let me look that up!",
          actions: ["PLAY_MUSIC_QUERY"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Play something like radiohead",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll find a similar artist!",
          actions: ["PLAY_MUSIC_QUERY"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Play some 80s synth pop",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Finding 80s synth pop for you!",
          actions: ["PLAY_MUSIC_QUERY"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Play workout music",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Let's get you pumped up!",
          actions: ["PLAY_MUSIC_QUERY"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Play a cover of wonderwall",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Looking for a cover version!",
          actions: ["PLAY_MUSIC_QUERY"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Play the Inception soundtrack",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Finding that soundtrack!",
          actions: ["PLAY_MUSIC_QUERY"],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;

export default playMusicQuery;
