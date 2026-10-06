/**
 * Tests for the gateway's Discord text chunking: per-message limit framing for
 * real model replies. The harness is deterministic (pure functions, no network,
 * no Discord client) and pins the delivered-message contract: chunks fit the
 * Discord content limit, a ``` marker is never cut in half across messages, a
 * split inside a code block leaves both messages fence-balanced, code content
 * survives the split, and the pre-existing limit/unicode guards are preserved.
 */
import { describe, expect, test } from "bun:test";
import {
  chunkDiscordText,
  DISCORD_MESSAGE_CONTENT_LIMIT,
} from "../src/discord-text-chunks";

const fenceCounts = (chunk: string) => (chunk.match(/```/g) ?? []).length;

/** A marker fragmented across messages shows as a dangling backtick run. */
const markerRuns = (chunk: string) => chunk.match(/`+/g) ?? [];

function expectWellFormedChunks(chunks: string[], limit: number) {
  for (const chunk of chunks) {
    expect(chunk.length).toBeLessThanOrEqual(limit);
  }
  for (let i = 0; i < chunks.length - 1; i += 1) {
    const tail = markerRuns(chunks[i]).at(-1);
    const head = markerRuns(chunks[i + 1])[0];
    const fragmentsMarker =
      tail !== undefined &&
      head !== undefined &&
      tail.length < 3 &&
      `${tail}${head}`.length >= 3;
    expect(fragmentsMarker, JSON.stringify(chunks[i].slice(-12))).toBe(false);
  }
}

describe("chunkDiscordText", () => {
  test("keeps the transport guards: invalid limits, empty input, sub-limit passthrough", () => {
    for (const limit of [0, 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => chunkDiscordText("hello", limit)).toThrow(RangeError);
    }
    expect(chunkDiscordText("")).toEqual([]);
    const short = "short reply";
    expect(chunkDiscordText(short)).toEqual([short]);
    expect(chunkDiscordText(short, 40)).toEqual([short]);
  });

  test("does not cut a fence marker in half at the message boundary", () => {
    // The 2000-char cut lands inside the ``` opener on a naive split.
    const intro = "x".repeat(1998);
    const reply = `${intro}\n\`\`\`\nconst x = 1;\n\`\`\`\nDone.`;
    const chunks = chunkDiscordText(reply);
    expect(chunks.length).toBeGreaterThan(1);
    expectWellFormedChunks(chunks, DISCORD_MESSAGE_CONTENT_LIMIT);
    for (const chunk of chunks) {
      expect(fenceCounts(chunk) % 2).toBe(0);
    }
    // The whole fence (opener + code) arrives intact in a single message.
    expect(chunks).toContain("```\nconst x = 1;\n```\nDone.");
  });

  test("keeps every message fence-balanced when a code block crosses the boundary", () => {
    const body = Array.from(
      { length: 120 },
      (_, i) => `line ${i} of the log output`,
    ).join("\n");
    const reply = `Intro paragraph.\n\n\`\`\`\n${body}\n\`\`\`\n\nOutro paragraph.`;
    const chunks = chunkDiscordText(reply);
    expect(chunks.length).toBeGreaterThan(1);
    for (const [index, chunk] of chunks.entries()) {
      expect(
        fenceCounts(chunk) % 2,
        `chunk ${index}: ${JSON.stringify(chunk.slice(0, 40))}`,
      ).toBe(0);
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_CONTENT_LIMIT);
    }

    // The code survives: stripping the synthetic close/reopen lines from the
    // joined chunks yields exactly the original code body.
    const codeLines = chunks
      .join("\n")
      .split("\n")
      .filter(
        (line) =>
          line.trim() !== "" &&
          !/```/.test(line) &&
          !line.startsWith("Intro") &&
          !line.startsWith("Outro"),
      );
    expect(codeLines.join("\n")).toBe(body);
    expect(chunks.at(-1)).toContain("Outro paragraph.");
  });

  test("sweep: paragraphs and fences of varying sizes stay well-formed at every limit", () => {
    const bodies = [3, 9, 40, 130].map((lines) =>
      Array.from(
        { length: lines },
        (_, i) => `statement ${i}; value = ${i * 7}`,
      ).join("\n"),
    );
    for (const body of bodies) {
      const reply = `First paragraph with some prose.\n\n\`\`\`ts\n${body}\n\`\`\`\n\nFinal paragraph.\n`;
      for (let limit = 40; limit <= 400; limit += 37) {
        for (const candidate of [limit, DISCORD_MESSAGE_CONTENT_LIMIT]) {
          const chunks = chunkDiscordText(reply, candidate);
          expect(chunks.length).toBeGreaterThanOrEqual(1);
          expectWellFormedChunks(chunks, candidate);
          for (const chunk of chunks) {
            expect(fenceCounts(chunk) % 2).toBe(0);
          }
          expect(chunks[0].startsWith("First paragraph")).toBe(true);
          expect(chunks.at(-1)).toContain("Final paragraph.");
        }
      }
    }
  });

  test("surrogate handling is unchanged: lone surrogates become U+FFFD and pairs stay whole", () => {
    const withLoneSurrogate = "ok \ud800 done";
    expect(chunkDiscordText(withLoneSurrogate)).toEqual(["ok \uFFFD done"]);

    const emoji = "😀".repeat(20);
    const chunks = chunkDiscordText(emoji, 9);
    expect(chunks.join("")).toBe(emoji);
    for (const chunk of chunks) {
      for (const char of chunk) {
        expect(char.codePointAt(0)).toBe(0x1f600);
      }
    }
  });
});
