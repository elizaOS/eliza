import type { Readable } from "node:stream";
import { logger } from "@elizaos/core";
import { createYtdlpStream } from "./ytdlpFallback";

export interface StreamCreationResult {
  stream: Readable;
  source: "yt-dlp";
}

/**
 * Canonical audio stream creation path.
 *
 * Streaming now relies on yt-dlp only so playback fails closed instead of
 * silently cascading across different extractors with different behavior.
 *
 * @param url - YouTube URL to stream
 * @returns Stream creation result with the stream and which tool succeeded
 * @throws Error if yt-dlp cannot create a playable stream
 */
export async function createAudioStream(
  url: string,
): Promise<StreamCreationResult> {
  try {
    logger.debug(`[stream] Attempting yt-dlp for: ${url}`);
    const stream = await createYtdlpStream(url);
    if (!stream) {
      throw new Error(`yt-dlp returned no playable stream for ${url}`);
    }

    logger.info(`[stream] Success with yt-dlp`);
    return {
      stream,
      source: "yt-dlp",
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[stream] yt-dlp failed for ${url}: ${errorMessage}`);
    throw new Error(
      `Failed to create audio stream from ${url}: ${errorMessage}\n` +
        "Ensure yt-dlp is installed and the source is accessible.",
    );
  }
}

/**
 * Check if a URL is a YouTube URL
 */
export function isYouTubeUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    return (
      (urlObj.hostname === "youtube.com" ||
        urlObj.hostname === "www.youtube.com" ||
        urlObj.hostname === "youtu.be" ||
        urlObj.hostname === "m.youtube.com") &&
      (urlObj.pathname.includes("/watch") ||
        urlObj.pathname.includes("/v/") ||
        urlObj.pathname.startsWith("/") ||
        urlObj.searchParams.has("v"))
    );
  } catch {
    return false;
  }
}
