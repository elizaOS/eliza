import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type {
  DetectedMusicEntity,
  MusicEntityDetectionService,
} from "../services/musicEntityDetectionService";
import type {
  ExtractedMusicInfo,
  WikipediaExtractionService,
} from "../services/wikipediaExtractionService";

/**
 * Provider that uses LLMs to dynamically extract music information from Wikipedia
 * Takes the full Wikipedia extract and uses LLM to intelligently extract relevant context
 */
export const wikipediaProvider: Provider = {
  name: "WIKIPEDIA_MUSIC",
  description:
    "Provides music information extracted from Wikipedia using LLM-based parsing",
  descriptionCompressed: "Music info from Wikipedia via LLM parsing.",
  position: 11, // After basic music info provider

  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    logger.debug("[WIKIPEDIA_MUSIC Provider] Starting provider execution");

    const messageText = message.content?.text || "";
    if (!messageText || messageText.trim().length === 0) {
      logger.debug("[WIKIPEDIA_MUSIC Provider] Empty message text");
      return { text: "", data: {}, values: {} };
    }

    logger.debug(
      `[WIKIPEDIA_MUSIC Provider] Processing message: "${messageText.substring(0, 100)}${messageText.length > 100 ? "..." : ""}"`,
    );

    // Use entity detection service to find music entities
    // This is more generic - it will detect music entities even without explicit keywords
    const entityDetectionService = runtime.getService(
      "musicEntityDetection",
    ) as MusicEntityDetectionService;
    if (!entityDetectionService) {
      logger.debug(
        "[WIKIPEDIA_MUSIC Provider] MusicEntityDetectionService not available",
      );
      return { text: "", data: {}, values: {} };
    }

    // Try to detect music entities - this uses LLM so it's smart about context
    let detectedEntities: DetectedMusicEntity[] = [];
    try {
      logger.debug("[WIKIPEDIA_MUSIC Provider] Attempting entity detection");
      detectedEntities =
        await entityDetectionService.detectEntities(messageText);
      logger.debug(
        `[WIKIPEDIA_MUSIC Provider] Detected ${detectedEntities.length} entities: ${detectedEntities.map((e) => `${e.type}:${e.name}`).join(", ")}`,
      );
    } catch (error) {
      logger.warn(
        `[WIKIPEDIA_MUSIC Provider] Entity detection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      // If entity detection fails, return empty
      return { text: "", data: {}, values: {} };
    }

    if (detectedEntities.length === 0) {
      logger.debug(
        "[WIKIPEDIA_MUSIC Provider] No entities detected, returning empty result",
      );
      return { text: "", data: {}, values: {} };
    }

    // Filter out URLs - Wikipedia extraction doesn't work with URLs
    const urlPattern = /^https?:\/\//i;
    const validEntities = detectedEntities.filter((entity) => {
      const isUrl = urlPattern.test(entity.name);
      if (isUrl) {
        logger.debug(
          `[WIKIPEDIA_MUSIC Provider] Skipping URL entity: ${entity.name}`,
        );
      }
      return !isUrl;
    });

    if (validEntities.length === 0) {
      logger.debug(
        "[WIKIPEDIA_MUSIC Provider] No valid entities after filtering URLs, returning empty result",
      );
      return { text: "", data: {}, values: {} };
    }

    logger.debug(
      `[WIKIPEDIA_MUSIC Provider] Processing ${validEntities.length} valid entities (filtered ${detectedEntities.length - validEntities.length} URLs)`,
    );

    // Determine context from state or message
    const purpose = determineContext(state, message);
    logger.debug(`[WIKIPEDIA_MUSIC Provider] Determined context: ${purpose}`);

    // Use Wikipedia extraction service for each entity
    const wikipediaExtractionService = runtime.getService(
      "wikipediaExtraction",
    ) as WikipediaExtractionService;
    if (!wikipediaExtractionService) {
      logger.debug(
        "[WIKIPEDIA_MUSIC Provider] WikipediaExtractionService not available",
      );
      return { text: "", data: {}, values: {} };
    }

    const extractedInfo: Array<{
      entity: DetectedMusicEntity;
      info: ExtractedMusicInfo;
    }> = [];

    for (const entity of validEntities.slice(0, 2)) {
      // Limit to 2 entities to avoid too many API calls
      logger.debug(
        `[WIKIPEDIA_MUSIC Provider] Extracting Wikipedia info for ${entity.type}: ${entity.name}`,
      );
      try {
        const context = {
          purpose,
          currentArtist: entity.type === "artist" ? entity.name : undefined,
          currentTrack: entity.type === "song" ? entity.name : undefined,
          currentAlbum: entity.type === "album" ? entity.name : undefined,
        };

        const info = await wikipediaExtractionService.extractFromWikipedia(
          entity.name,
          entity.type,
          context,
        );

        if (info) {
          extractedInfo.push({ entity, info });
          logger.debug(
            `[WIKIPEDIA_MUSIC Provider] Successfully extracted Wikipedia info for ${entity.name}`,
          );
        } else {
          logger.debug(
            `[WIKIPEDIA_MUSIC Provider] No Wikipedia info extracted for ${entity.name}`,
          );
        }
      } catch (error) {
        logger.warn(
          `[WIKIPEDIA_MUSIC Provider] Error extracting Wikipedia info for ${entity.type} "${entity.name}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (extractedInfo.length === 0) {
      logger.debug(
        "[WIKIPEDIA_MUSIC Provider] No Wikipedia info extracted, returning empty result",
      );
      return { text: "", data: {}, values: {} };
    }

    logger.debug(
      `[WIKIPEDIA_MUSIC Provider] Extracted info for ${extractedInfo.length} entity/entities`,
    );

    // Format extracted information for the prompt
    const contextTexts: string[] = [];
    for (const item of extractedInfo) {
      const parts: string[] = [];
      parts.push(`${item.entity.type}: ${item.entity.name}`);

      if (item.info.relatedArtists && item.info.relatedArtists.length > 0) {
        parts.push(`Related artists: ${item.info.relatedArtists.join(", ")}`);
      }
      if (item.info.influences && item.info.influences.length > 0) {
        parts.push(`Influences: ${item.info.influences.join(", ")}`);
      }
      if (item.info.genres && item.info.genres.length > 0) {
        parts.push(`Genres: ${item.info.genres.join(", ")}`);
      }
      if (item.info.interestingFacts && item.info.interestingFacts.length > 0) {
        parts.push(`Facts: ${item.info.interestingFacts.join("; ")}`);
      }
      if (
        item.info.selectionSuggestions &&
        item.info.selectionSuggestions.length > 0
      ) {
        parts.push(`Suggestions: ${item.info.selectionSuggestions.join(", ")}`);
      }

      if (parts.length > 1) {
        contextTexts.push(parts.join("\n"));
      }
    }

    if (contextTexts.length === 0) {
      return { text: "", data: {}, values: {} };
    }

    const text = `[WIKIPEDIA MUSIC CONTEXT]\n${contextTexts.join("\n\n")}\n[/WIKIPEDIA MUSIC CONTEXT]`;

    logger.debug(
      `[WIKIPEDIA_MUSIC Provider] Returning ${text.length} characters of Wikipedia context text`,
    );

    return {
      text,
      data: {
        wikipediaInfo: extractedInfo,
      },
      values: {
        wikipediaText: text,
      },
    };
  },
};

/**
 * Determine context purpose from state or message
 */
function determineContext(
  _state: State,
  message: Memory,
): "dj_intro" | "music_selection" | "general_info" | "related_artists" {
  const messageText = (message.content?.text || "").toLowerCase();

  if (
    messageText.includes("introduce") ||
    messageText.includes("intro") ||
    messageText.includes("dj")
  ) {
    return "dj_intro";
  }
  if (
    messageText.includes("select") ||
    messageText.includes("suggest") ||
    messageText.includes("recommend") ||
    messageText.includes("play")
  ) {
    return "music_selection";
  }
  if (
    messageText.includes("related") ||
    messageText.includes("similar") ||
    messageText.includes("influence")
  ) {
    return "related_artists";
  }

  return "general_info";
}
