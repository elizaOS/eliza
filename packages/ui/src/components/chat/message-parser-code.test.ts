// Unit tests for `parseSegments` code handling: lifting fenced code blocks into
// code segments (with language) and splitting inline `code` spans out of prose.
// Pure functions over string fixtures — no model, no render.

import { describe, expect, it } from "vitest";
import {
  conversationTranscriptText,
  parseSegments,
  splitInlineCode,
} from "./message-parser-helpers";

describe("parseSegments — fenced code blocks", () => {
  it("lifts a fenced code block into a code segment with its language", () => {
    const segments = parseSegments(
      "Here you go:\n```ts\nconst x = 1;\nconsole.log(x);\n```\nDone.",
      false,
    );
    const code = segments.find((s) => s.kind === "code");
    expect(code).toBeDefined();
    if (code?.kind !== "code") throw new Error("expected code segment");
    expect(code.inline).toBe(false);
    expect(code.lang).toBe("ts");
    // The fence markers + language tag are stripped; the body is exact.
    expect(code.code).toBe("const x = 1;\nconsole.log(x);");
    // Surrounding prose is kept as text segments around the block.
    expect(
      segments.some((s) => s.kind === "text" && /Here you go/.test(s.text)),
    ).toBe(true);
    expect(
      segments.some((s) => s.kind === "text" && /Done\./.test(s.text)),
    ).toBe(true);
  });

  it("handles a fenced block with no language tag", () => {
    const segments = parseSegments("```\nplain code\n```", false);
    expect(segments).toHaveLength(1);
    const seg = segments[0];
    if (seg.kind !== "code") throw new Error("expected code segment");
    expect(seg.lang).toBeUndefined();
    expect(seg.code).toBe("plain code");
  });

  it("does not lift a fenced UiSpec JSON into raw code (stays an interactive widget)", () => {
    const spec = JSON.stringify({
      root: "a",
      elements: { a: { type: "text" } },
    });
    const segments = parseSegments(`\`\`\`json\n${spec}\n\`\`\``, false);
    expect(segments.some((s) => s.kind === "ui-spec")).toBe(true);
    expect(segments.some((s) => s.kind === "code")).toBe(false);
  });

  it("leaves a plain message with no fences as a single text segment", () => {
    const segments = parseSegments("just a normal message", false);
    expect(segments).toEqual([{ kind: "text", text: "just a normal message" }]);
  });
});

describe("splitInlineCode", () => {
  it("splits a sentence with an inline code span into ordered parts", () => {
    const parts = splitInlineCode("Run `npm install` first.");
    expect(parts).toEqual([
      { kind: "text", text: "Run " },
      { kind: "code", code: "npm install" },
      { kind: "text", text: " first." },
    ]);
  });

  it("returns a single text part when there is no backticked span", () => {
    expect(splitInlineCode("no code here")).toEqual([
      { kind: "text", text: "no code here" },
    ]);
  });

  it("treats an empty backtick pair as plain text", () => {
    expect(splitInlineCode("a `` b")).toEqual([
      { kind: "text", text: "a `` b" },
    ]);
  });

  it("handles multiple inline code spans", () => {
    const parts = splitInlineCode("`a` and `b`");
    expect(parts.filter((p) => p.kind === "code")).toHaveLength(2);
  });
});

describe("conversationTranscriptText", () => {
  it("renders each turn as a Speaker: text block using the agent name", () => {
    const text = conversationTranscriptText(
      [
        { role: "user", text: "hello" },
        { role: "assistant", text: "hi there" },
      ],
      { agentName: "Ada" },
    );
    expect(text).toBe("You: hello\n\nAda: hi there");
  });

  it("skips empty / whitespace-only turns", () => {
    const text = conversationTranscriptText([
      { role: "user", text: "  " },
      { role: "assistant", text: "real reply" },
    ]);
    expect(text).toBe("Assistant: real reply");
  });

  it("returns an empty string for an empty conversation", () => {
    expect(conversationTranscriptText([])).toBe("");
  });
});
