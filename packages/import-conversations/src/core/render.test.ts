/** Unit tests for transcript rendering (headers, message formatting). Deterministic, string-in/string-out. */

import { describe, expect, it } from "vitest";
import { renderConversation, renderHeader, renderMessage } from "./render.ts";
import type { NormalizedConversation, NormalizedMessage } from "./types.ts";

const T = (iso: string) => Date.parse(iso);

function baseConv(messages: NormalizedMessage[]): NormalizedConversation {
  return {
    sourceConversationId: "c1",
    title: "My chat",
    createdAt: T("2024-05-01T12:00:00Z"),
    updatedAt: T("2024-05-01T12:30:00Z"),
    messages,
  };
}

describe("renderHeader", () => {
  it("renders title + source + date", () => {
    const h = renderHeader(baseConv([]), "chatgpt");
    expect(h).toBe("# My chat (imported from ChatGPT, 2024-05-01)");
  });
  it("falls back to Untitled and omits date when absent", () => {
    const h = renderHeader(
      { sourceConversationId: "x", messages: [] },
      "hermes",
    );
    expect(h).toBe("# Untitled conversation (imported from Hermes)");
  });
});

describe("renderMessage", () => {
  it("formats role + timestamp + text", () => {
    const out = renderMessage({
      role: "user",
      text: "hello world",
      createdAt: T("2024-05-01T12:00:00Z"),
    });
    expect(out).toBe("**user** (2024-05-01 12:00): hello world");
  });

  it("omits timestamp when absent", () => {
    expect(renderMessage({ role: "assistant", text: "hi" })).toBe(
      "**assistant**: hi",
    );
  });

  it("renders an attachment-only (empty text) message", () => {
    const out = renderMessage({
      role: "user",
      text: "",
      attachments: [
        { name: "notes.txt", kind: "extracted-text", text: "line a\nline b" },
      ],
    });
    expect(out).toContain("**user**");
    expect(out).toContain("> [extracted-text: notes.txt]");
    expect(out).toContain("> line a");
    expect(out).toContain("> line b");
  });

  it("renders an image placeholder attachment without inline text", () => {
    const out = renderMessage({
      role: "user",
      text: "look",
      attachments: [{ name: "pic.png", kind: "image" }],
    });
    expect(out).toContain("> [image: pic.png]");
  });
});

describe("renderConversation splitting", () => {
  it("returns a single part for a short conversation", () => {
    const parts = renderConversation(
      baseConv([
        { role: "user", text: "hi" },
        { role: "assistant", text: "hello" },
      ]),
      "chatgpt",
    );
    expect(parts).toHaveLength(1);
    expect(parts[0].partCount).toBe(1);
    expect(parts[0].text).toContain("# My chat");
    expect(parts[0].text).toContain("**user**: hi");
    expect(parts[0].firstMessageIndex).toBe(0);
    expect(parts[0].lastMessageIndex).toBe(1);
  });

  it("splits long conversations at message boundaries with overlap", () => {
    // Each message ~ 400 chars ≈ 100 tokens; budget small to force splitting.
    const big = "x".repeat(400);
    const messages: NormalizedMessage[] = Array.from(
      { length: 10 },
      (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        text: `${i}-${big}`,
      }),
    );
    const parts = renderConversation(baseConv(messages), "chatgpt", {
      maxPartTokens: 250,
      overlapMessages: 2,
    });
    expect(parts.length).toBeGreaterThan(1);
    // Overlap: the first message of part n appears in the tail of part n-1.
    for (let i = 1; i < parts.length; i++) {
      expect(parts[i].firstMessageIndex).toBeLessThanOrEqual(
        parts[i - 1].lastMessageIndex,
      );
    }
    // Coverage: last part reaches the final message.
    expect(parts.at(-1)?.lastMessageIndex).toBe(messages.length - 1);
    // All parts carry the part suffix.
    expect(parts[0].text).toContain("part 1/");
  });

  it("always makes forward progress even if one message exceeds the budget", () => {
    const huge = "y".repeat(5000);
    const messages: NormalizedMessage[] = [
      { role: "user", text: huge },
      { role: "assistant", text: huge },
      { role: "user", text: huge },
    ];
    const parts = renderConversation(baseConv(messages), "claude", {
      maxPartTokens: 100,
      overlapMessages: 1,
    });
    // 3 oversized messages → at least 3 parts, terminates (no infinite loop).
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(parts.at(-1)?.lastMessageIndex).toBe(2);
  });

  it("handles an empty conversation (header-only part)", () => {
    const parts = renderConversation(baseConv([]), "hermes");
    expect(parts).toHaveLength(1);
    expect(parts[0].messageCount).toBe(0);
    expect(parts[0].text).toContain("# My chat");
  });
});
