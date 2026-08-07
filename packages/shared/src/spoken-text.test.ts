/**
 * Unit coverage for `sanitizeSpeechText` (`spoken-text.ts`): strips internal
 * thinking/reasoning blocks (closed and unterminated), fenced code, and URLs (while
 * keeping markdown link labels and inline-code words), then collapses stage
 * directions and repeated punctuation before text is handed to TTS.
 */
import { describe, expect, it } from "vitest";

import { sanitizeSpeechText } from "./spoken-text";

describe("sanitizeSpeechText", () => {
  it("removes closed internal thinking and reasoning blocks", () => {
    expect(
      sanitizeSpeechText(
        "Say this. <think>hide this</think> <analysis>hide that</analysis> Done.",
      ),
    ).toBe("Say this. Done.");
  });

  it("removes unterminated internal blocks through the end of the text", () => {
    expect(sanitizeSpeechText("Visible. <think>do not speak this")).toBe(
      "Visible.",
    );
    expect(
      sanitizeSpeechText("Answer. <analysis>private reasoning\nstill private"),
    ).toBe("Answer.");
  });

  it("removes fenced code blocks and keeps inline code words speakable", () => {
    expect(
      sanitizeSpeechText(
        "Use `bun test`. ```ts\nconst secret = true;\n``` Done.",
      ),
    ).toBe("Use bun test. Done.");
  });

  it("keeps markdown link labels while removing URLs", () => {
    expect(
      sanitizeSpeechText(
        "Open [the docs](https://example.com/docs) at https://x.test.",
      ),
    ).toBe("Open the docs at");
  });

  it("removes non-speech directions and cleans repeated punctuation", () => {
    expect(
      sanitizeSpeechText("*whispers* Wait!!! (pause) Are you sure??"),
    ).toBe("Wait! Are you sure?");
  });
});
