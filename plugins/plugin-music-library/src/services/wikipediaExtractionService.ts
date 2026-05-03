import { type IAgentRuntime, logger, ModelType, Service } from "@elizaos/core";
import type { AlbumInfo, ArtistInfo, TrackInfo } from "../types";
import type { WikipediaService } from "./wikipediaClient";

const WIKIPEDIA_EXTRACTION_SERVICE_NAME = "wikipediaExtraction";

export interface WikipediaExtractionContext {
  purpose: "dj_intro" | "music_selection" | "general_info" | "related_artists";
  currentArtist?: string;
  currentTrack?: string;
  currentAlbum?: string;
}

export interface ExtractedMusicInfo {
  artist?: Partial<ArtistInfo>;
  track?: Partial<TrackInfo>;
  album?: Partial<AlbumInfo>;
  relatedArtists?: string[];
  influences?: string[];
  genres?: string[];
  interestingFacts?: string[];
  selectionSuggestions?: string[];
}

type WikipediaExtractionSourceData =
  | {
      type: "artist";
      name: string;
      bio?: string;
      genres?: string[];
      similarArtists?: string[];
      image?: string;
    }
  | {
      type: "song";
      name: string;
      description?: string;
      artist?: string;
      album?: string;
      year?: number;
      genre?: string[];
    }
  | {
      type: "album";
      name: string;
      description?: string;
      artist?: string;
      year?: number;
      genre?: string[];
    };

/**
 * Service that uses LLMs to dynamically extract relevant information from Wikipedia
 * Based on context (e.g., DJ intro, music selection), extracts different information
 */
export class WikipediaExtractionService extends Service {
  static serviceType: string = WIKIPEDIA_EXTRACTION_SERVICE_NAME;
  capabilityDescription =
    "Uses LLM to dynamically extract music information from Wikipedia based on context";

  private cache: Map<string, { data: ExtractedMusicInfo; timestamp: number }> =
    new Map();
  private readonly CACHE_TTL = 3600000; // 1 hour in milliseconds

  static async start(
    runtime: IAgentRuntime,
  ): Promise<WikipediaExtractionService> {
    logger.debug(
      `Starting WikipediaExtractionService for agent ${runtime.character.name}`,
    );
    return new WikipediaExtractionService(runtime);
  }

  private getWikipediaService(): WikipediaService | null {
    return this.runtime?.getService("wikipedia") as WikipediaService | null;
  }

  async stop(): Promise<void> {
    this.clearCache();
  }

  /**
   * Extract music information from Wikipedia using LLM based on context
   */
  async extractFromWikipedia(
    entityName: string,
    entityType: "artist" | "album" | "song",
    context: WikipediaExtractionContext,
  ): Promise<ExtractedMusicInfo | null> {
    if (!this.runtime) {
      return null;
    }

    // Create cache key
    const cacheKey = `${entityType}:${entityName}:${context.purpose}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }

    try {
      // Fetch full Wikipedia page
      const wikipediaService = this.getWikipediaService();
      if (!wikipediaService) {
        return null;
      }

      let wikiData: WikipediaExtractionSourceData | null = null;
      if (entityType === "artist") {
        const artistInfo = await wikipediaService.getArtistInfo(entityName);
        if (artistInfo) {
          wikiData = {
            type: "artist",
            name: entityName,
            bio: artistInfo.bio,
            genres: artistInfo.genres,
            similarArtists: artistInfo.similarArtists,
            image: artistInfo.image,
          };
        }
      } else if (entityType === "song") {
        const trackInfo = await wikipediaService.getTrackInfo(entityName);
        if (trackInfo) {
          wikiData = {
            type: "song",
            name: entityName,
            description: trackInfo.description,
            artist: trackInfo.artist,
            album: trackInfo.album,
            year: trackInfo.year,
            genre: trackInfo.genre,
          };
        }
      } else if (entityType === "album") {
        // Would need artist name for albums
        const albumInfo = await wikipediaService.getAlbumInfo(
          entityName,
          context.currentArtist,
        );
        if (albumInfo) {
          wikiData = {
            type: "album",
            name: entityName,
            description: albumInfo.description,
            artist: albumInfo.artist,
            year: albumInfo.year,
            genre: albumInfo.genre,
          };
        }
      }

      if (!wikiData) {
        return null;
      }

      // Use LLM to extract relevant information based on context
      const extractionPrompt = this.buildExtractionPrompt(wikiData, context);
      const extractionResponse = await this.runtime.useModel(
        ModelType.TEXT_LARGE,
        {
          prompt: extractionPrompt,
          maxTokens: 500,
        },
      );

      // Parse LLM response
      const extracted = this.parseExtractionResponse(
        extractionResponse as string,
        context,
      );

      // Cache result
      this.cache.set(cacheKey, {
        data: extracted,
        timestamp: Date.now(),
      });

      return extracted;
    } catch (error) {
      logger.error(`Error extracting Wikipedia info: ${error}`);
      return null;
    }
  }

  /**
   * Build extraction prompt based on context
   */
  private buildExtractionPrompt(
    wikiData: WikipediaExtractionSourceData,
    context: WikipediaExtractionContext,
  ): string {
    const basePrompt = `Extract relevant music information from the following Wikipedia data based on the context.

Wikipedia Data:
${JSON.stringify(wikiData, null, 2)}

Context: ${context.purpose}
${context.currentArtist ? `Current Artist: ${context.currentArtist}` : ""}
${context.currentTrack ? `Current Track: ${context.currentTrack}` : ""}
${context.currentAlbum ? `Current Album: ${context.currentAlbum}` : ""}

`;

    switch (context.purpose) {
      case "dj_intro":
        return (
          basePrompt +
          `Extract information that would be interesting for a radio DJ introduction:
- Interesting facts and trivia about the artist/song (prioritize fun, surprising, or noteworthy facts)
- Genre and style information
- Related artists or influences
- Release year or historical context
- Any notable achievements, awards, or interesting backstories
- Fun anecdotes or stories about the song/artist
- Chart positions or commercial success (if notable)
- Cultural impact or significance

Format as JSON with keys: interestingFacts (array of strings - prioritize the most interesting/entertaining facts), genres (array), relatedArtists (array), influences (array), year (number if available).`
        );

      case "music_selection":
        return (
          basePrompt +
          `Extract information that would help with intelligent music selection:
- Related artists and influences (for discovering similar music)
- Genre information
- Musical style characteristics
- Artists that influenced this artist
- Artists that were influenced by this artist

Format as JSON with keys: relatedArtists (array), influences (array), genres (array), selectionSuggestions (array of artist/song names).`
        );

      case "related_artists":
        return (
          basePrompt +
          `Extract all related artists, influences, and similar acts:
- Artists that influenced this artist
- Artists influenced by this artist
- Similar artists or genre peers
- Associated acts or collaborators

Format as JSON with keys: influences (array), relatedArtists (array), similarArtists (array).`
        );

      default:
        return (
          basePrompt +
          `Extract general music information:
- Genre and style
- Related artists
- Influences
- Interesting facts

Format as JSON with keys: genres (array), relatedArtists (array), influences (array), interestingFacts (array).`
        );
    }
  }

  /**
   * Parse LLM extraction response
   */
  private parseExtractionResponse(
    response: string,
    _context: WikipediaExtractionContext,
  ): ExtractedMusicInfo {
    const extracted: ExtractedMusicInfo = {};

    try {
      // Try to extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        extracted.relatedArtists =
          parsed.relatedArtists || parsed.similarArtists;
        extracted.influences = parsed.influences;
        extracted.genres = parsed.genres;
        extracted.interestingFacts = parsed.interestingFacts;
        extracted.selectionSuggestions = parsed.selectionSuggestions;
      } else {
        // Fallback: try to extract lists from text
        extracted.relatedArtists = this.extractList(
          response,
          /related[:\s]+(.*?)(?:\n|$)/i,
        );
        extracted.influences = this.extractList(
          response,
          /influenc[es]*[:\s]+(.*?)(?:\n|$)/i,
        );
        extracted.genres = this.extractList(
          response,
          /genre[s]*[:\s]+(.*?)(?:\n|$)/i,
        );
        extracted.interestingFacts = this.extractList(
          response,
          /fact[s]*[:\s]+(.*?)(?:\n|$)/i,
        );
      }
    } catch (error) {
      logger.warn(`Failed to parse extraction response: ${error}`);
    }

    return extracted;
  }

  /**
   * Extract list items from text using pattern
   */
  private extractList(text: string, pattern: RegExp): string[] {
    const match = text.match(pattern);
    if (!match?.[1]) {
      return [];
    }

    return match[1]
      .split(/[,;]| and | & /)
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .slice(0, 10); // Limit to 10 items
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Clear expired cache entries
   */
  clearExpiredCache(): void {
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp >= this.CACHE_TTL) {
        this.cache.delete(key);
      }
    }
  }
}
