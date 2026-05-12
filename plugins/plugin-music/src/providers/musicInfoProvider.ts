import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { MusicLibraryService } from "../services/musicLibraryService";
import type { AlbumInfo, ArtistInfo, TrackInfo } from "../types";

type MusicInfoItem =
  | { type: "track"; info: TrackInfo }
  | { type: "artist"; info: ArtistInfo }
  | { type: "album"; info: AlbumInfo };

const MAX_DETECTED_ENTITIES = 3;
const MAX_MUSIC_INFO_TEXT = 6000;

/**
 * Provider that injects music information context into the agent's state
 * This is particularly useful for DJ introductions and music-related conversations
 * Uses entity detection to find music references in casual conversation
 */
export const musicInfoProvider: Provider = {
  name: "MUSIC_INFO",
  description: "Provides information about tracks, artists, and albums",
  descriptionCompressed: "Track, artist, album info.",
  position: 10, // Position after basic providers but before complex ones
  contexts: ["media", "knowledge"],
  contextGate: { anyOf: ["media", "knowledge"] },
  cacheStable: false,
  cacheScope: "turn",

  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    try {
      logger.debug("[MUSIC_INFO Provider] Starting provider execution");

      const musicLibrary = runtime.getService(
        "musicLibrary",
      ) as MusicLibraryService | null;
      if (!musicLibrary) {
        logger.debug(
          "[MUSIC_INFO Provider] Music library service not available",
        );
        return { text: "", data: {}, values: {} };
      }

      // Extract potential music references from the message
      const messageText = message.content?.text || "";
      if (!messageText || messageText.trim().length === 0) {
        logger.debug("[MUSIC_INFO Provider] Empty message text");
        return { text: "", data: {}, values: {} };
      }

      logger.debug(
        `[MUSIC_INFO Provider] Processing message: "${messageText.substring(0, 100)}${messageText.length > 100 ? "..." : ""}"`,
      );

      const musicInfo: MusicInfoItem[] = [];

      logger.debug("[MUSIC_INFO Provider] Attempting entity detection");
      const detectedEntities = await musicLibrary.detectEntities(messageText);
      logger.debug(
        `[MUSIC_INFO Provider] Detected ${detectedEntities.length} entities: ${detectedEntities.map((e) => `${e.type}:${e.name}`).join(", ")}`,
      );

      for (const entity of detectedEntities.slice(0, MAX_DETECTED_ENTITIES)) {
        logger.debug(
          `[MUSIC_INFO Provider] Fetching info for ${entity.type}: ${entity.name}`,
        );
        if (entity.type === "song") {
          const trackInfo = await musicLibrary.getTrackInfo(entity.name);
          if (trackInfo?.track) {
            musicInfo.push({ type: "track", info: trackInfo.track });
            logger.debug(
              `[MUSIC_INFO Provider] Successfully fetched track info for: ${entity.name}`,
            );
          }
        } else if (entity.type === "artist") {
          const artistInfo = await musicLibrary.getArtistInfo(entity.name);
          if (artistInfo) {
            musicInfo.push({ type: "artist", info: artistInfo });
            logger.debug(
              `[MUSIC_INFO Provider] Successfully fetched artist info for: ${entity.name}`,
            );
          }
        } else if (entity.type === "album") {
          const albumInfo = await musicLibrary.getAlbumInfo(entity.name);
          if (albumInfo) {
            musicInfo.push({ type: "album", info: albumInfo });
            logger.debug(
              `[MUSIC_INFO Provider] Successfully fetched album info for: ${entity.name}`,
            );
          }
        }
      }

      if (musicInfo.length === 0) {
        logger.debug(
          "[MUSIC_INFO Provider] No music info found, returning empty result",
        );
        return { text: "", data: {}, values: {} };
      }

      logger.debug(
        `[MUSIC_INFO Provider] Found ${musicInfo.length} music info item(s)`,
      );

      const text = JSON.stringify(
        {
          music_info: musicInfo.map((item) => ({
            type: item.type,
            ...item.info,
          })),
        },
        null,
        2,
      ).slice(0, MAX_MUSIC_INFO_TEXT);

      logger.debug(
        `[MUSIC_INFO Provider] Returning ${text.length} characters of music info text`,
      );

      return {
        text,
        data: {
          musicInfo,
        },
        values: {
          musicInfoText: text,
        },
      };
    } catch {
      return { text: "", data: {}, values: {} };
    }
  },
};
