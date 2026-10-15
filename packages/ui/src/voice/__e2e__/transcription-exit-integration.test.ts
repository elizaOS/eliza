/**
 * Integration: punctuated exit phrase flows from detection through the real
 * `TranscriptSessionAccumulator` into the saved record.
 *
 * This mirrors the exact sequence in `useShellController.ts` (exit detection
 * -> stripExitPhrase -> transcriptSession.addFinal -> build), using the real
 * accumulator class — not mocks. It proves the preserved prefix reaches the
 * saved transcript segments, which the helper-only tests do not cover.
 */
import { describe, expect, it } from "vitest";
import { TranscriptSessionAccumulator } from "../transcript-session";
import {
  isTranscriptionExitPhrase,
  stripExitPhrase,
} from "../transcription-exit";

/**
 * Replicates the transcription-mode exit path from useShellController.ts:
 * on a final transcript, detect the exit phrase, fold the preceding content
 * into the session, then finalize (mode ends).
 */
function handleTranscriptionFinal(
  accumulator: TranscriptSessionAccumulator,
  text: string,
): { exited: boolean } {
  if (isTranscriptionExitPhrase(text)) {
    const preceding = stripExitPhrase(text);
    if (preceding) {
      accumulator.addFinal(preceding, Date.now());
    }
    return { exited: true };
  }
  accumulator.addFinal(text, Date.now());
  return { exited: false };
}

describe("transcription exit -> saved record", () => {
  it("saves the dictated prefix when the exit phrase contains a comma", () => {
    const acc = new TranscriptSessionAccumulator(Date.now());
    const result = handleTranscriptionFinal(
      acc,
      "Note this down: stop, transcription",
    );
    expect(result.exited).toBe(true);
    const segments = acc.build();
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe("Note this down:");
  });

  it("saves the dictated prefix when the exit phrase contains a period", () => {
    const acc = new TranscriptSessionAccumulator(Date.now());
    const result = handleTranscriptionFinal(
      acc,
      "Please stop. transcription now",
    );
    expect(result.exited).toBe(true);
    const segments = acc.build();
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe("Please");
  });

  it("keeps ordinary dictation in the session without exiting", () => {
    const acc = new TranscriptSessionAccumulator(Date.now());
    const result = handleTranscriptionFinal(
      acc,
      "Remember to buy milk tomorrow",
    );
    expect(result.exited).toBe(false);
    const segments = acc.build();
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe("Remember to buy milk tomorrow");
  });

  it("accumulates multiple turns then exits with the prefix preserved", () => {
    const acc = new TranscriptSessionAccumulator(Date.now());
    handleTranscriptionFinal(acc, "First idea for the meeting");
    handleTranscriptionFinal(acc, "Second idea about the budget");
    const result = handleTranscriptionFinal(
      acc,
      "And finally, stop, transcription",
    );
    expect(result.exited).toBe(true);
    const segments = acc.build();
    expect(segments).toHaveLength(3);
    expect(segments.map((s) => s.text)).toEqual([
      "First idea for the meeting",
      "Second idea about the budget",
      "And finally,",
    ]);
  });
});
