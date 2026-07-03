import type { Content } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  castId,
  castUuid,
  extractCastEmbedUrls,
  lastCastCacheKey,
  MAX_CAST_LENGTH,
  splitParagraph,
  splitPostContent,
} from "../utils/index";

/**
 * Farcaster cast helpers. splitPostContent must keep every emitted cast within
 * the protocol length cap while preferring paragraph then sentence then word
 * boundaries (so a long agent post is threaded, never truncated); castUuid must
 * be deterministic per (hash, agentId); and embed-url extraction must drop
 * blank/missing attachment urls.
 */

describe("splitPostContent", () => {
  it("returns the text unchanged when it fits", () => {
    expect(splitPostContent("short cast", 100)).toEqual(["short cast"]);
  });

  it("splits on paragraph boundaries and keeps each chunk within the limit", () => {
    const para = (n: number) => `paragraph number ${n} with some filler words here`;
    const text = [para(1), para(2), para(3)].join("\n\n");
    const chunks = splitPostContent(text, 60);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 60)).toBe(true);
  });

  it("hard-splits a single oversized paragraph by sentence/word", () => {
    const long = `${"word ".repeat(80)}.`;
    const chunks = splitPostContent(long, 50);
    expect(chunks.every((c) => c.length <= 50)).toBe(true);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("defaults to MAX_CAST_LENGTH for splittable (spaced) text", () => {
    const chunks = splitPostContent("word ".repeat(MAX_CAST_LENGTH).trim());
    expect(chunks.every((c) => c.length <= MAX_CAST_LENGTH)).toBe(true);
  });

  it("keeps every chunk within the cap for a single unbroken over-limit word (long URL)", () => {
    const url = `https://example.com/${"a".repeat(1200)}`;
    const chunks = splitPostContent(url, 1024);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length > 0 && c.length <= 1024)).toBe(true);
  });
});

describe("splitParagraph", () => {
  it("keeps a single sentence intact when it fits", () => {
    expect(splitParagraph("One whole sentence here.", 100)).toEqual(["One whole sentence here."]);
  });

  it("rejoins multiple sentences (note: the matcher keeps the inter-sentence space)", () => {
    // The sentence regex captures the trailing space on the next sentence, and
    // the rejoin adds its own — documenting the existing double-space behavior.
    expect(splitParagraph("One sentence. Two sentence.", 100)).toEqual([
      "One sentence.  Two sentence.",
    ]);
  });

  it("hard-slices a word longer than maxLength instead of emitting an over-limit chunk", () => {
    const word = "x".repeat(120);
    const chunks = splitParagraph(word, 50);
    expect(chunks.every((c) => c.length <= 50)).toBe(true);
    expect(chunks.join("")).toBe(word);
  });
});

describe("castId / castUuid", () => {
  it("castId joins hash and agentId; castUuid is deterministic", () => {
    expect(castId({ hash: "0xabc", agentId: "agent-1" })).toBe("0xabc-agent-1");
    const a = castUuid({ hash: "0xabc", agentId: "agent-1" });
    const b = castUuid({ hash: "0xabc", agentId: "agent-1" });
    expect(a).toBe(b);
    expect(castUuid({ hash: "0xabc", agentId: "agent-2" })).not.toBe(a);
  });
});

describe("extractCastEmbedUrls", () => {
  it("returns non-empty attachment urls only", () => {
    const content = {
      attachments: [{ url: "https://x.com/a.png" }, { url: "  " }, {}, { url: "https://x.com/b" }],
    } as unknown as Content;
    expect(extractCastEmbedUrls(content)).toEqual(["https://x.com/a.png", "https://x.com/b"]);
    expect(extractCastEmbedUrls({} as Content)).toEqual([]);
  });
});

describe("lastCastCacheKey", () => {
  it("namespaces by fid", () => {
    expect(lastCastCacheKey(42)).toBe("farcaster/42/lastCast");
  });
});
