/**
 * Tests held-out corpus boundary parsing, complete-prefix replay conversion,
 * deterministic selection, and explicit rejection of malformed source rows.
 * The tests use small source-shaped fixtures and no network access.
 */
import { describe, expect, test } from "bun:test";
import {
  convertDiscordRow,
  deterministicDiscordOffsets,
  parseDiscordChatml,
} from "./discord-replay.ts";
import { parseIshikiRow, selectIshikiPoints } from "./ishiki-generate.ts";

const chatml =
  "<|im_start|>user\nfirst<|im_end|>\n" +
  "<|im_start|>assistant\nsecond\nline<|im_end|>\n" +
  "<|im_start|>user\nthird<|im_end|><|end_of_text|>";

describe("Discord replay conversion", () => {
  test("parses the complete ChatML chain without changing message text", () => {
    expect(parseDiscordChatml(chatml)).toEqual([
      { speaker: "participant_a", text: "first" },
      { speaker: "participant_b", text: "second\nline" },
      { speaker: "participant_a", text: "third" },
    ]);
  });

  test("emits paired observed labels and preserves the full prefix", () => {
    const points = convertDiscordRow({ rowIndex: 42, text: chatml });
    expect(points).toHaveLength(4);
    expect(points[2].turns).toEqual([
      { speaker: "participant_a", text: "first" },
      { speaker: "participant_b", text: "second\nline" },
    ]);
    expect(points[2].label).toBe("speak");
    expect(points[2].targetSpeaker).toBe("participant_a");
    expect(points[3].labelKind).toBe("observed-other-speaker");
    expect(points[3].sourceTrace.nextTurnIndex).toBe(2);
  });

  test("uses stable, unique source row offsets", () => {
    const first = deterministicDiscordOffsets();
    expect(first).toEqual(deterministicDiscordOffsets());
    expect(new Set(first).size).toBe(first.length);
  });

  test("rejects unconsumed ChatML", () => {
    expect(() => parseDiscordChatml(`${chatml}junk`)).toThrow(
      "complete multi-turn chain",
    );
  });
});

describe("ishiki-labs scenario selection", () => {
  const makeRow = (id: string, decision: "SPEAK" | "SILENT") =>
    parseIshikiRow(
      {
        decision_point_id: id,
        target_speaker: "B",
        context_turns: [{ speaker: "A", text: `context ${id}` }],
        current_turn: { speaker: "A", text: `current ${id}` },
        decision,
        target_is_addressed: decision === "SPEAK",
      },
      "ami",
    );

  test("validates and maps source labels", () => {
    const point = makeRow("sample", "SPEAK");
    expect(point.label).toBe("speak");
    expect(point.context[0].text).toBe("context sample");
    expect(point.directlyAddressed).toBe(true);
  });

  test("maps the target participant onto the runtime agent seat", () => {
    const point = parseIshikiRow(
      {
        decision_point_id: "addressed",
        target_speaker: "Ross",
        context_turns: [{ speaker: "Ross", text: "I was already here" }],
        current_turn: { speaker: "Rachel", text: "Ross, what do you think?" },
        decision: "SPEAK",
        target_is_addressed: true,
      },
      "friends",
    );
    expect(point.context[0].speaker).toBe("ScenarioAgent");
    expect(point.decisionTurn.text).toBe("ScenarioAgent, what do you think?");
  });

  test("selects the same rows regardless of input order", () => {
    const points = [];
    for (const domain of ["ami", "friends", "spgi"] as const) {
      for (const decision of ["SPEAK", "SILENT"] as const) {
        for (let index = 0; index < 6; index += 1) {
          const base = makeRow(`${domain}-${decision}-${index}`, decision);
          points.push({ ...base, sourceDomain: domain });
        }
      }
    }
    expect(
      selectIshikiPoints(points).map((point) => point.decisionPointId),
    ).toEqual(
      selectIshikiPoints([...points].reverse()).map(
        (point) => point.decisionPointId,
      ),
    );
  });

  test("rejects a missing current turn instead of fabricating one", () => {
    expect(() =>
      parseIshikiRow(
        {
          decision_point_id: "bad",
          target_speaker: "B",
          context_turns: [],
          decision: "SILENT",
          target_is_addressed: false,
        },
        "ami",
      ),
    ).toThrow("current_turn");
  });
});
