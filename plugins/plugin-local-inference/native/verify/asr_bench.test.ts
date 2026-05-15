import { describe, expect, test } from "bun:test";

import {
  labelledSetEvidenceFor,
  normalizeWavDirProvenance,
} from "./asr_bench";

describe("asr_bench labelled-set provenance", () => {
  test("self-labelled TTS loopback is not publish-gate ASR WER", () => {
    expect(
      labelledSetEvidenceFor({ source: "tts_loopback_self_labelled" }),
    ).toMatchObject({
      measurementClass: "self_labelled_tts_asr_loopback",
      provenance: "generated_tts",
      realRecordedWer: false,
      publishGateEligible: false,
    });
  });

  test("wav-dir defaults to unknown provenance and stays fail-closed", () => {
    expect(labelledSetEvidenceFor({ source: "external_wav_txt" })).toMatchObject(
      {
        measurementClass: "external_labelled_unknown_provenance",
        provenance: "external_unknown",
        realRecordedWer: false,
        publishGateEligible: false,
      },
    );
  });

  test("generated wav-dir is loopback evidence, not real recorded WER", () => {
    expect(
      labelledSetEvidenceFor({
        source: "external_wav_txt",
        wavDirProvenance: "generated-tts",
      }),
    ).toMatchObject({
      measurementClass: "external_generated_tts_loopback",
      provenance: "generated_tts",
      realRecordedWer: false,
      publishGateEligible: false,
    });
  });

  test("real recorded WER requires an explicit flag or provenance", () => {
    expect(
      labelledSetEvidenceFor({
        source: "external_wav_txt",
        realRecorded: true,
      }),
    ).toMatchObject({
      measurementClass: "real_recorded_labelled_speech",
      provenance: "real_recorded",
      realRecordedWer: true,
      publishGateEligible: true,
    });
    expect(normalizeWavDirProvenance("real-recorded")).toBe("real_recorded");
  });

  test("rejects contradictory real-recorded and generated claims", () => {
    expect(() =>
      labelledSetEvidenceFor({
        source: "external_wav_txt",
        wavDirProvenance: "generated-tts",
        realRecorded: true,
      }),
    ).toThrow(/conflicts/);
  });
});
