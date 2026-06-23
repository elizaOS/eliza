import { describe, expect, it } from "vitest";
import {
  buildConversationTranscript,
  parseSegments,
} from "./message-parser-helpers";

describe("parseSegments — fenced code blocks (#9148)", () => {
  it("extracts a fenced code block as a `code` segment with its language", () => {
    const text = "Here you go:\n```ts\nconst x = 1;\n```\nDone.";
    const segs = parseSegments(text, false);
    const code = segs.find((s) => s.kind === "code");
    expect(code).toBeDefined();
    if (code?.kind === "code") {
      expect(code.lang).toBe("ts");
      expect(code.code).toBe("const x = 1;\n");
    }
    // Surrounding prose stays as text segments.
    expect(segs.filter((s) => s.kind === "text").length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it("handles a fence with no language info-string", () => {
    const segs = parseSegments("```\nplain\n```", false);
    const code = segs.find((s) => s.kind === "code");
    expect(code?.kind === "code" && code.lang).toBe("");
    expect(code?.kind === "code" && code.code).toBe("plain\n");
  });

  it("keeps a fence-free message on the plain-text fast path", () => {
    const segs = parseSegments("no code here", false);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toEqual({ kind: "text", text: "no code here" });
  });

  it("captures an unterminated fence (mid-stream) so it renders incrementally", () => {
    const segs = parseSegments("```js\nstreaming...", false);
    const code = segs.find((s) => s.kind === "code");
    expect(code?.kind === "code" && code.lang).toBe("js");
    expect(code?.kind === "code" && code.code).toBe("streaming...");
  });

  it("yields to a UiSpec fence rather than treating it as a code block", () => {
    const spec = JSON.stringify({
      root: "a",
      elements: { a: { type: "text" } },
    });
    const segs = parseSegments("```json\n" + spec + "\n```", false);
    expect(segs.some((s) => s.kind === "ui-spec")).toBe(true);
    expect(segs.some((s) => s.kind === "code")).toBe(false);
  });

  it("renders a non-UiSpec JSON fence as a copyable code block", () => {
    const segs = parseSegments('```json\n{"a":1}\n```', false);
    expect(segs.some((s) => s.kind === "code")).toBe(true);
    expect(segs.some((s) => s.kind === "ui-spec")).toBe(false);
  });
});

describe("buildConversationTranscript (#9148)", () => {
  it("labels turns by role and separates them with blank lines", () => {
    const transcript = buildConversationTranscript([
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi there" },
    ]);
    expect(transcript).toBe("User: hello\n\nAssistant: hi there");
  });

  it("strips hidden reasoning/stage blocks from assistant turns", () => {
    const transcript = buildConversationTranscript([
      { role: "assistant", text: "<think>secret</think>visible answer" },
    ]);
    expect(transcript).toBe("Assistant: visible answer");
    expect(transcript).not.toContain("secret");
  });

  it("skips empty turns", () => {
    const transcript = buildConversationTranscript([
      { role: "user", text: "   " },
      { role: "assistant", text: "kept" },
    ]);
    expect(transcript).toBe("Assistant: kept");
  });

  it("honors custom role labels", () => {
    const transcript = buildConversationTranscript(
      [{ role: "user", text: "yo" }],
      { userLabel: "Me" },
    );
    expect(transcript).toBe("Me: yo");
  });
});
