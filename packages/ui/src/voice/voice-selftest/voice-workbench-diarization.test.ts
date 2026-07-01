// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  scoreWorkbenchDiarization,
  type VoiceWorkbenchTurnReport,
} from "./voice-workbench-player";

/**
 * Regression guard for #9427: the diarization DER gate must be able to FAIL on a
 * real misattribution. The prior gate copied the predicted label from the
 * ground-truth `speaker` field, so predicted always equalled expected and DER
 * was always 0 (tautological). These tests pin the gate's honest behavior:
 * predicted ≠ expected ⇒ confusion ⇒ DER up ⇒ gate fails; predicted null ⇒ miss.
 */
function turn(
  partial: Pick<
    VoiceWorkbenchTurnReport,
    "expectedSpeakerLabel" | "predictedSpeakerLabel"
  > &
    Partial<VoiceWorkbenchTurnReport>,
): VoiceWorkbenchTurnReport {
  return {
    index: partial.index ?? 0,
    speaker: partial.speaker ?? partial.expectedSpeakerLabel,
    status: partial.status ?? "pass",
    responded: true,
    expectRespond: true,
    transcript: "",
    expectedTranscript: "",
    reply: "",
    durationMs: 1,
    ...partial,
  } as VoiceWorkbenchTurnReport;
}

describe("scoreWorkbenchDiarization (#9427)", () => {
  it("passes only when predicted matches expected", () => {
    const report = scoreWorkbenchDiarization([
      turn({
        expectedSpeakerLabel: "speaker_a",
        predictedSpeakerLabel: "speaker_a",
      }),
      turn({
        expectedSpeakerLabel: "speaker_b",
        predictedSpeakerLabel: "speaker_b",
      }),
    ]);
    expect(report.der).toBe(0);
    expect(report.confusions).toBe(0);
    expect(report.passed).toBe(true);
  });

  it("FAILS on a real misattribution (predicted != expected)", () => {
    const report = scoreWorkbenchDiarization([
      turn({
        expectedSpeakerLabel: "speaker_a",
        predictedSpeakerLabel: "speaker_a",
      }),
      // speaker_b's turn mis-attributed to speaker_a by the diarizer:
      turn({
        expectedSpeakerLabel: "speaker_b",
        predictedSpeakerLabel: "speaker_a",
      }),
    ]);
    expect(report.confusions).toBe(1);
    expect(report.der).toBeGreaterThan(0);
    expect(report.evaluated).toBe(true);
    expect(report.passed).toBe(false);
  });

  it("reports SKIPPED (not pass, not fail) when no attribution ran (all null)", () => {
    const report = scoreWorkbenchDiarization([
      turn({ expectedSpeakerLabel: "speaker_a", predictedSpeakerLabel: null }),
      turn({ expectedSpeakerLabel: "speaker_b", predictedSpeakerLabel: null }),
    ]);
    // No diarizer on this host → unattributed, excluded from DER. The gate is
    // not evaluated — never a false pass, never a spurious failure (#9147).
    expect(report.unattributed).toBe(2);
    expect(report.total).toBe(0);
    expect(report.confusions).toBe(0);
    expect(report.der).toBe(0);
    expect(report.evaluated).toBe(false);
    expect(report.passed).toBe(false);
  });

  it("is not tautological: a turn whose predicted == ground-truth speaker but != expected still fails", () => {
    // The old code set predicted = turn.speaker; here speaker matches the
    // ground-truth voice but the EXPECTED diarization label differs (e.g. the
    // owner speaking under a re-labeled identity). The honest gate must fail.
    const report = scoreWorkbenchDiarization([
      turn({
        speaker: "speaker_a",
        expectedSpeakerLabel: "owner",
        predictedSpeakerLabel: "speaker_a",
      }),
    ]);
    expect(report.confusions).toBe(1);
    expect(report.passed).toBe(false);
  });
});
