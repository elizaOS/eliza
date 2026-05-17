import { describe, expect, it } from "vitest";

import { FallbackG2PPhonemizer, KOKORO_PAD_ID } from "./phonemizer.js";

describe("FallbackG2PPhonemizer", () => {
  it("uses Kokoro tokenizer boundary ids and IPA for common smoke phrases", async () => {
    const seq = await new FallbackG2PPhonemizer().phonemize(
      "Hello there.",
      "a",
    );

    expect(seq.phonemes).toBe("hɛloʊ ðɛɹ.");
    expect(Array.from(seq.ids)).toEqual([
      KOKORO_PAD_ID,
      50,
      86,
      54,
      57,
      135,
      16,
      81,
      86,
      123,
      4,
      KOKORO_PAD_ID,
    ]);
  });
});
