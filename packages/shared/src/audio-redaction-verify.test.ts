/**
 * Covers the re-transcribe verifier contract (#14807): PII-absence by
 * normalized containment (never transcript equality — hallucinated filler
 * over silence must not fail a clean redaction), sentinel-presence as the
 * over-mute guard, the multi-backend matrix (all must pass), the typed
 * no-verifier failure (never a vacuous pass), and backend-throw propagation.
 */

import { describe, expect, it } from "vitest";
import {
  AudioRedactionVerifyUnavailableError,
  findMissingSentinels,
  findResidualPii,
  judgeRedactedTranscript,
  type RedactionTranscriber,
  verifyAudioRedaction,
} from "./audio-redaction-verify";

const INPUT = {
  audio: new Uint8Array([1, 2, 3]),
  mimeType: "audio/wav",
};

function fixedTranscriber(id: string, text: string): RedactionTranscriber {
  return { id, transcribe: () => Promise.resolve({ text }) };
}

describe("findResidualPii", () => {
  it("finds PII across separators and casing (fuzzy, not equality)", () => {
    expect(findResidualPii("my number is 555-01 23 ok", ["555 0123"])).toEqual([
      "555 0123",
    ]);
    expect(findResidualPii("JOHN smith called", ["John Smith"])).toEqual([
      "John Smith",
    ]);
  });

  it("returns [] when the PII is gone, even if filler was hallucinated", () => {
    expect(
      findResidualPii("my name is [inaudible] thank you", ["John Smith"]),
    ).toEqual([]);
  });
});

describe("findMissingSentinels", () => {
  it("reports sentinels the transcript lost (over-mute guard)", () => {
    expect(
      findMissingSentinels("the weather is sunny", ["weather", "deadline"]),
    ).toEqual(["deadline"]);
  });
});

describe("judgeRedactedTranscript", () => {
  it("passes only with all PII absent and all sentinels present", () => {
    const clean = judgeRedactedTranscript("v", "the weather is sunny", {
      piiTexts: ["John Smith"],
      sentinelTexts: ["weather"],
    });
    expect(clean.ok).toBe(true);

    const leaked = judgeRedactedTranscript("v", "john smith and the weather", {
      piiTexts: ["John Smith"],
      sentinelTexts: ["weather"],
    });
    expect(leaked.ok).toBe(false);
    expect(leaked.piiFound).toEqual(["John Smith"]);

    const overMuted = judgeRedactedTranscript("v", "…", {
      piiTexts: ["John Smith"],
      sentinelTexts: ["weather"],
    });
    expect(overMuted.ok).toBe(false);
    expect(overMuted.sentinelsMissing).toEqual(["weather"]);
  });
});

describe("verifyAudioRedaction", () => {
  const expectation = {
    piiTexts: ["John Smith"],
    sentinelTexts: ["weather"],
  };

  it("throws typed when no verifier is configured — never a vacuous pass", async () => {
    await expect(verifyAudioRedaction([], INPUT, expectation)).rejects.toThrow(
      AudioRedactionVerifyUnavailableError,
    );
  });

  it("passes only when EVERY backend passes", async () => {
    const good = fixedTranscriber("a", "the weather is sunny");
    const blind = fixedTranscriber("b", "john smith likes the weather");
    const both = await verifyAudioRedaction([good, blind], INPUT, expectation);
    expect(both.ok).toBe(false);
    expect(both.findings.map((finding) => finding.ok)).toEqual([true, false]);

    const clean = await verifyAudioRedaction([good], INPUT, expectation);
    expect(clean.ok).toBe(true);
    expect(clean.findings[0].transcript).toBe("the weather is sunny");
  });

  it("propagates a backend failure instead of passing around it", async () => {
    const broken: RedactionTranscriber = {
      id: "broken",
      transcribe: () => Promise.reject(new Error("ASR unavailable")),
    };
    await expect(
      verifyAudioRedaction([broken], INPUT, expectation),
    ).rejects.toThrow("ASR unavailable");
  });
});
