import {
  type IAgentRuntime,
  logger,
  ModelType,
} from "@elizaos/core";
import { parseJsonObjectResponse } from "../utils/json";

const MUSIC_ENTITY_DETECTION_SERVICE_NAME = "musicEntityDetection";

export interface DetectedMusicEntity {
  type: "artist" | "album" | "song";
  name: string;
  confidence: number; // 0-1
  context?: string; // Surrounding text
}

interface RawDetectedMusicEntity {
  type?: unknown;
  name?: unknown;
  confidence?: unknown;
  context?: unknown;
}

/**
 * Service for detecting music entity names (artists, albums, songs) from text
 * Uses LLM for intelligent extraction with caching
 */
export class MusicEntityDetectionHelper {
  capabilityDescription =
    "Detects music entity names (artists, albums, songs) from text using LLM";

  private cache: Map<
    string,
    { entities: DetectedMusicEntity[]; timestamp: number }
  > = new Map();
  private readonly CACHE_TTL = 3600000; // 1 hour in milliseconds
  private readonly runtime?: IAgentRuntime;

  constructor(runtime?: IAgentRuntime) {
    this.runtime = runtime;
  }

  async stop(): Promise<void> {
    this.clearCache();
  }

  /**
   * Detect music entities from text using LLM
   */
  async detectEntities(text: string): Promise<DetectedMusicEntity[]> {
    if (!text || text.trim().length === 0) {
      return [];
    }

    // Check cache
    const cacheKey = `detect:${text.substring(0, 200)}`; // Use first 200 chars as key
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.entities;
    }

    if (!this.runtime) {
      throw new Error("Music entity detection requires a runtime");
    }

    try {
      const prompt = `Extract music-related entities from the following text. Identify artists, albums, and songs.

Text: "${text}"

Return detected entities as JSON. Each entity should have:
- type: "artist", "album", or "song"
- name: the entity name (exact as mentioned)
- confidence: a number between 0 and 1 indicating confidence
- context: a brief snippet of surrounding text (optional)

IMPORTANT RULES:
- Do NOT include URLs (like YouTube links, Spotify links, etc.) as entities
- Only extract actual artist names, album titles, or song titles
- URLs should be completely ignored

Example format:
{
  "entities": [
    {"type": "artist", "name": "The Beatles", "confidence": 0.9, "context": "mentioned in conversation"},
    {"type": "song", "name": "Bohemian Rhapsody", "confidence": 0.8}
  ]
}

If no music entities are found, return:
{"entities": []}

IMPORTANT: Only return JSON. Do not include explanation or extra text.`;

      const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        maxTokens: 500,
      });

      // Parse JSON response
      let entities: DetectedMusicEntity[] = [];
      try {
        const cleaned = String(response).trim();
        let parsedEntities: RawDetectedMusicEntity[] = [];
        const parsedJson = parseJsonObjectResponse<{
          entities?: RawDetectedMusicEntity[];
        }>(cleaned);
        if (Array.isArray(parsedJson?.entities)) {
          parsedEntities = parsedJson.entities;
        }

        // Validate and filter entities
        const urlPattern = /^https?:\/\//i;
        entities = parsedEntities
          .filter((e: RawDetectedMusicEntity) => {
            // Basic validation
            if (!e || typeof e !== "object") return false;
            if (
              typeof e.type !== "string" ||
              !["artist", "album", "song"].includes(e.type)
            ) {
              return false;
            }
            if (typeof e.name !== "string" || e.name.trim().length === 0)
              return false;
            if (
              typeof e.confidence !== "number" ||
              e.confidence < 0 ||
              e.confidence > 1
            )
              return false;

            // Filter out URLs
            if (urlPattern.test(e.name)) {
              return false;
            }

            return true;
          })
          .map((e: RawDetectedMusicEntity): DetectedMusicEntity => {
            const context =
              typeof e.context === "string" ? e.context.trim() : undefined;

            return {
              type: e.type as DetectedMusicEntity["type"],
              name: (e.name as string).trim(),
              confidence: e.confidence as number,
              context,
            };
          })
          .filter((e: DetectedMusicEntity) => e.confidence > 0.3); // Filter low confidence
      } catch (parseError) {
        throw new Error(
          `Failed to parse music entity detection response: ${
            parseError instanceof Error
              ? parseError.message
              : String(parseError)
          }`,
        );
      }

      // Cache results
      this.cache.set(cacheKey, {
        entities,
        timestamp: Date.now(),
      });

      return entities;
    } catch (error) {
      logger.error(`Error detecting music entities: ${error}`);
      throw error;
    }
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

export const MUSIC_ENTITY_DETECTION_HELPER_NAME =
  MUSIC_ENTITY_DETECTION_SERVICE_NAME;

export { MusicEntityDetectionHelper as MusicEntityDetectionService };
