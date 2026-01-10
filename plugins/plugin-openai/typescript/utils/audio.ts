/**
 * Audio utilities for OpenAI plugin
 *
 * Provides audio format detection and stream conversion utilities.
 */

import { logger } from "@elizaos/core";

// ============================================================================
// Constants
// ============================================================================

/**
 * Magic bytes for audio format detection
 */
const MAGIC_BYTES = {
  WAV: {
    HEADER: [0x52, 0x49, 0x46, 0x46] as const, // "RIFF"
    IDENTIFIER: [0x57, 0x41, 0x56, 0x45] as const, // "WAVE"
  },
  MP3_ID3: [0x49, 0x44, 0x33] as const, // "ID3"
  OGG: [0x4f, 0x67, 0x67, 0x53] as const, // "OggS"
  FLAC: [0x66, 0x4c, 0x61, 0x43] as const, // "fLaC"
  FTYP: [0x66, 0x74, 0x79, 0x70] as const, // "ftyp" at offset 4 for mp4/m4a
  WEBM_EBML: [0x1a, 0x45, 0xdf, 0xa3] as const, // EBML header
} as const;

/**
 * Minimum buffer size for format detection
 */
const MIN_DETECTION_BUFFER_SIZE = 12;

// ============================================================================
// Types
// ============================================================================

/**
 * Known audio MIME types
 */
export type AudioMimeType =
  | "audio/wav"
  | "audio/mpeg"
  | "audio/ogg"
  | "audio/flac"
  | "audio/mp4"
  | "audio/webm"
  | "application/octet-stream";

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Checks if buffer bytes match expected pattern at given offset.
 *
 * @param buffer - The buffer to check
 * @param offset - Start offset in buffer
 * @param expected - Expected byte sequence
 * @returns True if bytes match
 */
function matchBytes(
  buffer: Buffer,
  offset: number,
  expected: readonly number[]
): boolean {
  for (let i = 0; i < expected.length; i++) {
    const expectedByte = expected[i];
    if (expectedByte === undefined || buffer[offset + i] !== expectedByte) {
      return false;
    }
  }
  return true;
}

// ============================================================================
// Public Functions
// ============================================================================

/**
 * Detects audio MIME type from buffer by checking magic bytes.
 *
 * Supports detection of:
 * - WAV (RIFF/WAVE)
 * - MP3 (ID3 tag or MPEG sync)
 * - OGG (OggS container)
 * - FLAC (fLaC)
 * - M4A/MP4 (ftyp atom)
 * - WebM (EBML header)
 *
 * @param buffer - The audio buffer to analyze
 * @returns The detected MIME type or 'application/octet-stream' if unknown
 */
export function detectAudioMimeType(buffer: Buffer): AudioMimeType {
  if (buffer.length < MIN_DETECTION_BUFFER_SIZE) {
    return "application/octet-stream";
  }

  // WAV: "RIFF" + size + "WAVE"
  if (
    matchBytes(buffer, 0, MAGIC_BYTES.WAV.HEADER) &&
    matchBytes(buffer, 8, MAGIC_BYTES.WAV.IDENTIFIER)
  ) {
    return "audio/wav";
  }

  // MP3: ID3 tag or MPEG frame sync
  const firstByte = buffer[0];
  const secondByte = buffer[1];
  if (
    matchBytes(buffer, 0, MAGIC_BYTES.MP3_ID3) ||
    (firstByte === 0xff && secondByte !== undefined && (secondByte & 0xe0) === 0xe0)
  ) {
    return "audio/mpeg";
  }

  // OGG: "OggS"
  if (matchBytes(buffer, 0, MAGIC_BYTES.OGG)) {
    return "audio/ogg";
  }

  // FLAC: "fLaC"
  if (matchBytes(buffer, 0, MAGIC_BYTES.FLAC)) {
    return "audio/flac";
  }

  // M4A/MP4: "ftyp" at offset 4
  if (matchBytes(buffer, 4, MAGIC_BYTES.FTYP)) {
    return "audio/mp4";
  }

  // WebM: EBML header
  if (matchBytes(buffer, 0, MAGIC_BYTES.WEBM_EBML)) {
    return "audio/webm";
  }

  logger.warn(
    "Could not detect audio format from buffer, using generic binary type"
  );
  return "application/octet-stream";
}

/**
 * Gets the appropriate file extension for an audio MIME type.
 *
 * @param mimeType - The MIME type
 * @returns The file extension (without dot)
 */
export function getExtensionForMimeType(mimeType: AudioMimeType): string {
  switch (mimeType) {
    case "audio/wav":
      return "wav";
    case "audio/mpeg":
      return "mp3";
    case "audio/ogg":
      return "ogg";
    case "audio/flac":
      return "flac";
    case "audio/mp4":
      return "m4a";
    case "audio/webm":
      return "webm";
    case "application/octet-stream":
      return "bin";
  }
}

/**
 * Gets the appropriate filename for audio data based on MIME type.
 *
 * @param mimeType - The MIME type
 * @returns A suitable filename
 */
export function getFilenameForMimeType(mimeType: AudioMimeType): string {
  const ext = getExtensionForMimeType(mimeType);
  return `recording.${ext}`;
}

/**
 * Converts a Web ReadableStream to a Node.js Readable stream.
 *
 * Uses dynamic import to avoid bundling node:stream in browser builds.
 *
 * @param webStream - The Web ReadableStream to convert
 * @returns A Node.js Readable stream
 * @throws Error if node:stream module is unavailable
 */
export async function webStreamToNodeStream(
  webStream: ReadableStream<Uint8Array>
): Promise<NodeJS.ReadableStream> {
  const { Readable } = await import("node:stream");
  const reader = webStream.getReader();

  return new Readable({
    async read() {
      const { done, value } = await reader.read();
      if (done) {
        this.push(null);
      } else {
        this.push(value);
      }
    },
    destroy(error, callback) {
      reader.cancel().finally(() => callback(error));
    },
  });
}

/**
 * Validates that audio data is in a supported format.
 *
 * @param buffer - The audio buffer to validate
 * @returns The detected MIME type
 * @throws Error if format is not supported
 */
export function validateAudioFormat(buffer: Buffer): AudioMimeType {
  const mimeType = detectAudioMimeType(buffer);
  if (mimeType === "application/octet-stream") {
    throw new Error(
      "Unable to detect audio format. Supported formats: WAV, MP3, OGG, FLAC, M4A, WebM"
    );
  }
  return mimeType;
}
