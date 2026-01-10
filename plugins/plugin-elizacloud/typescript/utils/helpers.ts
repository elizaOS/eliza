import { logger } from "@elizaos/core";
import { JSONParseError } from "ai";
import type { ImageDescriptionResult } from "../types";

/**
 * Returns a function to repair JSON text
 */
export function getJsonRepairFunction(): (params: {
  text: string;
  error: unknown;
}) => Promise<string | null> {
  return async ({ text, error }: { text: string; error: unknown }) => {
    try {
      if (error instanceof JSONParseError) {
        const cleanedText = text.replace(/```json\n|\n```|```/g, "");
        JSON.parse(cleanedText);
        return cleanedText;
      }
      return null;
    } catch (jsonError: unknown) {
      const message =
        jsonError instanceof Error ? jsonError.message : String(jsonError);
      logger.warn(`Failed to repair JSON text: ${message}`);
      return null;
    }
  };
}

/**
 * Detects audio MIME type from buffer by checking magic bytes (file signature)
 * @param buffer The audio buffer to analyze
 * @returns The detected MIME type or 'application/octet-stream' if unknown
 */
export function detectAudioMimeType(buffer: Buffer): string {
  if (buffer.length < 12) {
    return "application/octet-stream";
  }

  // Check magic bytes for common audio formats
  // WAV: "RIFF" + size + "WAVE"
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x41 &&
    buffer[10] === 0x56 &&
    buffer[11] === 0x45
  ) {
    return "audio/wav";
  }

  // MP3: ID3 tag or MPEG frame sync
  if (
    (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) || // ID3
    (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) // MPEG sync
  ) {
    return "audio/mpeg";
  }

  // OGG: "OggS"
  if (
    buffer[0] === 0x4f &&
    buffer[1] === 0x67 &&
    buffer[2] === 0x67 &&
    buffer[3] === 0x53
  ) {
    return "audio/ogg";
  }

  // FLAC: "fLaC"
  if (
    buffer[0] === 0x66 &&
    buffer[1] === 0x4c &&
    buffer[2] === 0x61 &&
    buffer[3] === 0x43
  ) {
    return "audio/flac";
  }

  // M4A/MP4: "ftyp" at offset 4
  if (
    buffer[4] === 0x66 &&
    buffer[5] === 0x74 &&
    buffer[6] === 0x79 &&
    buffer[7] === 0x70
  ) {
    return "audio/mp4";
  }

  // WebM: EBML header
  if (
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    return "audio/webm";
  }

  // Unknown format - let API try to detect
  logger.warn(
    "Could not detect audio format from buffer, using generic binary type",
  );
  return "application/octet-stream";
}

/**
 * Converts a Web ReadableStream to a Node.js Readable stream
 * Handles both browser and Node.js environments
 * Uses dynamic import to avoid bundling node:stream in browser builds
 */
export async function webStreamToNodeStream(
  webStream: ReadableStream<Uint8Array>,
) {
  try {
    // Dynamic import to avoid browser bundling issues
    const { Readable } = await import("node:stream");
    const reader = webStream.getReader();

    return new Readable({
      async read() {
        try {
          const { done, value } = await reader.read();
          if (done) {
            this.push(null);
          } else {
            // Push the Uint8Array directly; Node.js Readable can handle it
            this.push(value);
          }
        } catch (error) {
          this.destroy(error as Error);
        }
      },
      destroy(error, callback) {
        reader.cancel().finally(() => callback(error));
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to load node:stream module: ${message}`);
    throw new Error(
      `Cannot convert stream: node:stream module unavailable. This feature requires a Node.js environment.`,
    );
  }
}

/**
 * Parses image description response from text format
 */
export function parseImageDescriptionResponse(
  responseText: string,
): ImageDescriptionResult {
  const titleMatch = responseText.match(/title[:\s]+(.+?)(?:\n|$)/i);
  const title = titleMatch?.[1]?.trim() || "Image Analysis";
  const description = responseText
    .replace(/title[:\s]+(.+?)(?:\n|$)/i, "")
    .trim();

  return { title, description };
}
