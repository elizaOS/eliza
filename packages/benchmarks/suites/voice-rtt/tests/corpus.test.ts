/**
 * Corpus tests keep the fixed voice RTT fixture stable across CI and live runs.
 */

import { describe, expect, it } from "vitest";
import { loadCorpus } from "../src/corpus.ts";

describe("corpus", () => {
  it("contains short, long, pause, and barge-in cases", () => {
    const corpus = loadCorpus();
    expect(corpus.map((entry) => entry.kind).sort()).toEqual([
      "barge-in",
      "long",
      "pause",
      "short",
    ]);
  });

  it("defines deterministic mock timings for each case", () => {
    for (const entry of loadCorpus()) {
      expect(entry.mockTimingsMs.sttFinalAfterInputEnd).toBeGreaterThan(0);
      expect(entry.mockTimingsMs.llmFirstTokenAfterAdmission).toBeGreaterThan(
        0,
      );
      expect(entry.mockTimingsMs.ttsFirstAudioAfterRequest).toBeGreaterThan(0);
    }
  });
});
