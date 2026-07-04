/**
 * Pure-function unit tests for LINE message shaping (`messaging.ts`): text
 * chunking, markdown stripping, link extraction, and chat-type detection. No
 * runtime or network.
 */
import { describe, expect, it } from "vitest";
import {
  chunkLineText,
  extractLinks,
  getChatId,
  getChatType,
  hasMarkdownContent,
  isGroupChat,
  processLineMessage,
  stripMarkdown,
  truncateText,
} from "./messaging.ts";

/**
 * LINE has no markdown rendering, so outbound text must be flattened: tables and
 * code blocks extracted, links surfaced, and inline formatting stripped to plain
 * text. Chunking must respect LINE's per-message length cap. Chat-context
 * helpers resolve group/room/user precedence for routing.
 */

describe("stripMarkdown", () => {
  it("removes bold/italic/strike/headers/inline-code", () => {
    expect(stripMarkdown("**bold** and *it* and ~~no~~")).toBe("bold and it and no");
    expect(stripMarkdown("# Heading")).toBe("Heading");
    expect(stripMarkdown("use `code` here")).toBe("use code here");
  });
});

describe("hasMarkdownContent", () => {
  it("detects markdown, false for plain text", () => {
    expect(hasMarkdownContent("**bold**")).toBe(true);
    expect(hasMarkdownContent("# h")).toBe(true);
    expect(hasMarkdownContent("just plain text")).toBe(false);
  });
});

describe("extractLinks", () => {
  it("pulls markdown links out of the text", () => {
    const { links } = extractLinks("see [docs](https://x.com/docs) now");
    expect(links.length).toBe(1);
    expect(links[0].url).toBe("https://x.com/docs");
  });
});

describe("processLineMessage", () => {
  it("returns plain text plus extracted code blocks", () => {
    const out = processLineMessage("hello\n```js\nconst a=1;\n```\nbye");
    expect(out.codeBlocks.length).toBe(1);
    expect(out.text).toContain("hello");
    expect(out.text).not.toContain("```");
  });
});

describe("chunkLineText", () => {
  it("keeps each chunk within the limit and preserves content", () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const chunks = chunkLineText(text, { limit: 30 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 30)).toBe(true);
    expect(chunks.join("\n").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
  });
});

describe("truncateText", () => {
  it("adds an ellipsis only when over the limit", () => {
    expect(truncateText("short", 20)).toBe("short");
    expect(truncateText("abcdefghij", 6)).toBe("abc...");
  });
});

describe("chat-context helpers", () => {
  it("isGroupChat / getChatId / getChatType honor group>room>user precedence", () => {
    expect(isGroupChat({ userId: "U1" } as never)).toBe(false);
    expect(isGroupChat({ groupId: "C1" })).toBe(true);
    expect(getChatId({ userId: "U1", roomId: "R1" })).toBe("R1");
    expect(getChatId({ userId: "U1" })).toBe("U1");
    expect(getChatType({ groupId: "C1" })).toBe("group");
    expect(getChatType({ roomId: "R1" })).toBe("room");
    expect(getChatType({})).toBe("user");
  });
});
