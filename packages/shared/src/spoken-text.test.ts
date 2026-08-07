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

  it("rewrites I am so Kokoro/espeak does not say yam", () => {
    expect(sanitizeSpeechText("I am ready.")).toBe("I'm ready.");
    expect(sanitizeSpeechText("Yes, I am here.")).toBe("Yes, I'm here.");
    expect(sanitizeSpeechText("I am Eliza.")).toBe("I'm Eliza.");
    expect(sanitizeSpeechText("I am not sure.")).toBe("I'm not sure.");
  });

  // A stranded copula cannot contract. A following-token test alone is not
  // enough — each of these has a word after "am" and is still ungrammatical
  // when contracted, so the preceding antecedent is what has to block it.
  it("leaves a copula stranded by wh-movement or fronting expanded", () => {
    expect(sanitizeSpeechText("Here I am at last.")).toBe("Here I am at last.");
    expect(sanitizeSpeechText("That is who I am today.")).toBe(
      "That is who I am today.",
    );
    expect(sanitizeSpeechText("I know who I am now.")).toBe(
      "I know who I am now.",
    );
    expect(sanitizeSpeechText("Wherever I am is home.")).toBe(
      "Wherever I am is home.",
    );
  });

  it("leaves a clause-final am expanded", () => {
    expect(sanitizeSpeechText("Yes, I am.")).toBe("Yes, I am.");
    expect(sanitizeSpeechText("Here I am!")).toBe("Here I am!");
    expect(sanitizeSpeechText("That is who I am.")).toBe("That is who I am.");
    expect(sanitizeSpeechText("Tell me who I am and I am done.")).toBe(
      "Tell me who I am and I'm done.",
    );
  });

  // "I AM" and "i am" mis-phonemize identically, so both must be fixed; the
  // replacement re-applies the observed casing rather than normalising it.
  it("contracts every casing and preserves it", () => {
    expect(sanitizeSpeechText("I AM READY")).toBe("I'M READY");
    expect(sanitizeSpeechText("yes i am ready")).toBe("yes i'm ready");
  });

  it("does not contract across a following clause boundary", () => {
    expect(sanitizeSpeechText("I am, however, ready.")).toBe(
      "I am, however, ready.",
    );
  });

  it("does not match a word that merely starts with am", () => {
    expect(sanitizeSpeechText("I ambient noise")).toBe("I ambient noise");
  });
});
