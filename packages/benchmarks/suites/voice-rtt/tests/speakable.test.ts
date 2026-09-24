/**
 * Speakable phrase boundary tests keep streaming TTS input complete but early.
 */

import { describe, expect, it } from "vitest";
import { firstSpeakablePhrase } from "../src/speakable.ts";

describe("firstSpeakablePhrase", () => {
  it("keeps a complete sentence when punctuation terminates the input", () => {
    expect(
      firstSpeakablePhrase("Your next calendar item is the product sync."),
    ).toBe("Your next calendar item is the product sync.");
  });

  it("cuts at the first terminal boundary in a longer stream", () => {
    expect(firstSpeakablePhrase("First sentence. Second sentence.")).toBe(
      "First sentence.",
    );
  });
});
