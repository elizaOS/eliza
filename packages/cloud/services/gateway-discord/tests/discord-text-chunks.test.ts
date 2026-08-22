/** Verifies lossless Discord framing across long text and Unicode boundaries. */

import { describe, expect, test } from "vitest";
import {
  chunkDiscordText,
  discordChunkNonce,
} from "../src/discord-text-chunks";

describe("Discord text chunks", () => {
  test("preserves a response longer than one million characters", () => {
    const text = `${"a".repeat(999_999)}🦊TAIL`;
    const chunks = chunkDiscordText(text);
    expect(chunks.every((chunk) => chunk.length <= 2_000)).toBe(true);
    expect(chunks.join("")).toBe(text);
    expect(chunks.at(-1)).toContain("TAIL");
  });

  test("never splits a surrogate pair", () => {
    const chunks = chunkDiscordText(`${"a".repeat(1_999)}🦊end`);
    expect(chunks.join("")).toBe(`${"a".repeat(1_999)}🦊end`);
    expect(chunks[0]).toBe("a".repeat(1_999));
  });

  test("derives stable provider-safe nonces for every chunk", () => {
    expect(discordChunkNonce("seed", 0)).toBe(discordChunkNonce("seed", 0));
    expect(discordChunkNonce("seed", 0)).not.toBe(discordChunkNonce("seed", 1));
    expect(discordChunkNonce("seed", 0)).toMatch(/^\d{1,20}$/);
  });
});
