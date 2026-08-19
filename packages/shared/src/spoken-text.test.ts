/**
 * Unit coverage for `sanitizeSpeechText` (`spoken-text.ts`): strips internal
 * thinking/reasoning blocks (closed and unterminated), fenced code, and URLs (while
 * keeping markdown link labels and inline-code words), then collapses stage
 * directions and repeated punctuation before text is handed to TTS.
 */
import { describe, expect, it } from "vitest";

import { sanitizeSpeechText } from "./spoken-text";

// Twin-pin: this table is byte-identical to the one in
// packages/core/src/spoken-text.test.ts. The two sanitizers share one contract
// ("hidden model markup must never reach spoken output"), so a fix landing on
// one side only must fail the other side's suite (#20519).
const hiddenBlockTags = [
  "think",
  "analysis",
  "reasoning",
  "tool_call",
  "tool_calls",
  "tool",
  "tools",
] as const;

describe("sanitizeSpeechText", () => {
  it.each(hiddenBlockTags)(
    "removes a closed <%s> block and preserves following speech",
    (tag) => {
      expect(
        sanitizeSpeechText(
          `Visible. <${tag}>private payload</${tag}> Continue.`,
        ),
      ).toBe("Visible. Continue.");
    },
  );

  it.each(hiddenBlockTags)(
    "removes an unterminated <%s> block through end of input",
    (tag) => {
      expect(sanitizeSpeechText(`Visible. <${tag}>private payload`)).toBe(
        "Visible.",
      );
    },
  );

  it.each(hiddenBlockTags)(
    "removes a truncated <%s> opening tag through end of input (#20519)",
    (tag) => {
      expect(sanitizeSpeechText(`Visible. <${tag} private payload`)).toBe(
        "Visible.",
      );
    },
  );

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

  it("keeps speech around a few nested stage-direction layers", () => {
    expect(
      sanitizeSpeechText("Hello (aside (whisper) still aside) world."),
    ).toBe("Hello world.");
  });

  it("fail-closes a nested-delimiter peel bomb without hanging TTS", () => {
    const nested = `(${"(".repeat(40_000)}hello${")".repeat(40_000)})`;
    const started = performance.now();
    const spoken = sanitizeSpeechText(`Say this. ${nested} Done.`);
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(50);
    expect(spoken).toBe("Say this. Done.");
  });
});
