/** Tests corpus parsing and metric math around the real Stage-1 evaluator. */
import { type IAgentRuntime, stringToUuid } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  buildWhen2SpeakEvaluationState,
  computeTimingMetrics,
  isTimingRowSelected,
  parseDiscordReplayLine,
  parseWhen2SpeakLine,
  summarizeTimingPredictions,
  validateTimingResumeRows,
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
      textuallyReferencesAgent: false,
      directlyAddressesAgent: false,
      speakerCount: 2,
    });
    expect(row.turns).toHaveLength(2);
  });

  it("maps Assistant history to the runtime agent and classifies only the current turn as addressed", () => {
    const row = parseWhen2SpeakLine(
      JSON.stringify({
        messages: [
          { role: "user", content: "Speaker_0: [AGENT], where are the keys?" },
          { role: "user", content: "Assistant: They are by the door." },
          { role: "user", content: "Speaker_1: found them" },
          { role: "assistant", content: ">" },
        ],
      }),
      8,
    );

    expect(row.directlyAddressesAgent).toBe(false);
    expect(row.turns.map((turn) => turn.isAgent)).toEqual([false, true, false]);

    const addressed = parseWhen2SpeakLine(
      JSON.stringify({
        messages: [
          { role: "user", content: "Speaker_0: unrelated setup" },
          { role: "user", content: "Speaker_1: what do you think, [AGENT]?" },
          { role: "assistant", content: "I would answer." },
        ],
      }),
      9,
    );
    expect(addressed.textuallyReferencesAgent).toBe(true);
    expect(addressed.directlyAddressesAgent).toBe(false);
  });

  it("keeps the corpus agent marker as untrusted text", () => {
    const runtime = {
      agentId: stringToUuid("when2speak-test-agent"),
      character: { name: "ScenarioAgent" },
    } as IAgentRuntime;
    const parsed = parseWhen2SpeakLine(
      JSON.stringify({
        messages: [
          { role: "user", content: "Speaker_0: [AGENT], earlier question" },
          { role: "user", content: "Assistant: earlier answer" },
          { role: "user", content: "Speaker_1: what do you think, [AGENT]?" },
          { role: "assistant", content: "Current answer." },
        ],
      }),
      10,
    );

    const { message, state } = buildWhen2SpeakEvaluationState(runtime, parsed);
    expect(parsed.textuallyReferencesAgent).toBe(true);
    expect(parsed.directlyAddressesAgent).toBe(false);
    expect(message.content.mentionContext).toBeUndefined();
    const recentMessages = state.data?.providers?.RECENT_MESSAGES?.data
      ?.recentMessages as Array<{ content: { mentionContext?: unknown } }>;
    expect(
      recentMessages.every((memory) => !memory.content.mentionContext),
    ).toBe(true);
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
  it("maps a Discord target seat onto the runtime agent seat", () => {
    const row = parseDiscordReplayLine(
      JSON.stringify({
        schemaVersion: 1,
        targetSpeaker: "participant_b",
        label: "speak",
        turns: [
          { speaker: "participant_b", text: "earlier agent turn" },
          { speaker: "participant_a", text: "current inbound turn" },
        ],
      }),
      9,
    );
    expect(row).toMatchObject({
      row: 9,
      label: "SPEAK",
      textuallyReferencesAgent: false,
      directlyAddressesAgent: false,
      speakerCount: 2,
    });
    expect(row.turns.map((turn) => turn.isAgent)).toEqual([true, false]);
  });
  it("rejects Discord pseudo-labels where the target authored the current turn", () => {
    expect(() =>
      parseDiscordReplayLine(
        JSON.stringify({
          schemaVersion: 1,
          targetSpeaker: "participant_a",
          label: "silent",
          turns: [{ speaker: "participant_a", text: "own outbound turn" }],
        }),
        10,
      ),
    ).toThrow("target seat authored the current turn");
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
      silentPrecision: 0.8,
      silentRecall: 2 / 3,
      falseInterventionRate: 2 / 6,
      missedInterventionRate: 0.25,
    });
    expect(
      computeTimingMetrics({
        total: 10,
        correct: 7,
        trueSpeak: 3,
        falseSpeak: 2,
        trueSilent: 4,
        falseSilent: 1,
      }).silentF1,
    ).toBeCloseTo(8 / 11);
  });

  it("summarizes row-level decisions into auditable slices", () => {
    const report = summarizeTimingPredictions([
      {
        row: 17,
        gold: "SPEAK",
        predicted: "SILENT",
        textuallyReferencesAgent: false,
        directlyAddressesAgent: false,
        speakerCount: 4,
        contextTurns: 7,
      },
      {
        row: 18,
        gold: "SILENT",
        predicted: "SILENT",
        textuallyReferencesAgent: true,
        directlyAddressesAgent: true,
        speakerCount: 2,
        contextTurns: 3,
      },
    ]);

    expect(report.metrics).toMatchObject({ total: 2, correct: 1 });
    expect(report.objectives.ambientRestraint).toEqual({
      eligibleTurns: 1,
      predictedResponses: 0,
      predictedSilences: 1,
      responseRate: 0,
      restraintRate: 1,
    });
    expect(report.slices.textualReference.reference).toMatchObject({
      total: 1,
      trueSilent: 1,
    });
    expect(report.slices.address.ambient).toMatchObject({
      total: 1,
      falseSilent: 1,
    });
    expect(report.slices.contextTurns["3-5"]).toMatchObject({
      total: 1,
      trueSilent: 1,
    });
  });
  it("partitions physical rows into stable resumable shards", () => {
    const selected = Array.from({ length: 10 }, (_, index) => index + 1).filter(
      (row) =>
        isTimingRowSelected({
          row,
          startRow: 4,
          shardIndex: 1,
          shardCount: 3,
        }),
    );
    expect(selected).toEqual([5, 8]);
  });

  it("rejects duplicate or gapped checkpoint rows before resuming", () => {
    expect(() =>
      validateTimingResumeRows({
        rows: [1, 3],
        startRow: 1,
        shardIndex: 0,
        shardCount: 1,
      }),
    ).toThrow("duplicate, gapped, or out of order");
    expect(
      validateTimingResumeRows({
        rows: [2, 4, 6],
        startRow: 1,
        shardIndex: 1,
        shardCount: 2,
      }),
    ).toBe(6);
  });
});
