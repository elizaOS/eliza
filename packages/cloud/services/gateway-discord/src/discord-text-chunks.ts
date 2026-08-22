/**
 * Losslessly adapts generated text to Discord's per-message content limit.
 * Platform limits are transport framing constraints, never permission to drop
 * the remainder of a model response.
 */

import { createHash } from "node:crypto";

export const DISCORD_MESSAGE_CONTENT_LIMIT = 2_000;

function toWellFormedUnicode(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[index] + value[index + 1];
        index += 1;
      } else {
        out += "\uFFFD";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += "\uFFFD";
    } else {
      out += value[index];
    }
  }
  return out;
}

export function chunkDiscordText(
  input: string,
  limit = DISCORD_MESSAGE_CONTENT_LIMIT,
): string[] {
  if (!Number.isInteger(limit) || limit < 2) {
    throw new RangeError(
      "Discord chunk limit must be an integer of at least 2",
    );
  }
  const text = toWellFormedUnicode(input);
  if (!text) return [];

  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + limit, text.length);
    const finalCode = text.charCodeAt(end - 1);
    if (finalCode >= 0xd800 && finalCode <= 0xdbff) end -= 1;
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks;
}

/** Stable decimal nonce for one chunk, within Discord's 25-character limit. */
export function discordChunkNonce(seed: string, index: number): string {
  return createHash("sha256")
    .update(`${seed}:${index}`)
    .digest()
    .readBigUInt64BE()
    .toString(10);
}
