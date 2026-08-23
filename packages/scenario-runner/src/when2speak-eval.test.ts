/** Tests corpus parsing and metric math around the real Stage-1 evaluator. */
import { describe, expect, it } from "vitest";
import {
  computeTimingMetrics,
  parseWhen2SpeakLine,
} from "./when2speak-eval.ts";

describe("When2Speak evaluator", () => {
  it("parses a complete labeled dialogue", () => {
    const row = parseWhen2SpeakLine(
      JSON.stringify({
        messages: [
          {
            role: "user",
            content: "Speaker_0: where did [AGENT] put the keys?",
          },
          { role: "user", content: "Speaker_1: no idea" },
          { role: "assistant", content: "By the door." },
        ],
      }),
      7,
    );
    expect(row).toMatchObject({
      row: 7,
      label: "SPEAK",
      directlyAddressesAgent: true,
      speakerCount: 2,
    });
    expect(row.turns).toHaveLength(2);
  });
  it("rejects malformed context instead of dropping it", () => {
    expect(() =>
      parseWhen2SpeakLine(
        JSON.stringify({
          messages: [
            { role: "user", content: "missing delimiter" },
            { role: "assistant", content: ">" },
          ],
        }),
        3,
      ),
    ).toThrow("unparseable speaker turn");
  });
  it("computes SPEAK and intervention metrics", () => {
    expect(
      computeTimingMetrics({
        total: 10,
        correct: 7,
        trueSpeak: 3,
        falseSpeak: 2,
        trueSilent: 4,
        falseSilent: 1,
      }),
    ).toMatchObject({
      accuracy: 0.7,
      speakPrecision: 0.6,
      speakRecall: 0.75,
      falseInterventionRate: 2 / 6,
      missedInterventionRate: 0.25,
    });
  });
});
