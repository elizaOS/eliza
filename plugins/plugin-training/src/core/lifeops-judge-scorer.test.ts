import { describe, expect, it } from "vitest";
import type {
  CerebrasChatRequest,
  CerebrasChatResponse,
} from "./cerebras-eval-model.js";
import {
  buildLifeOpsJudgePrompt,
  createLifeOpsJudgeCompare,
  encodeJudgeExpectation,
  LIFEOPS_JUDGE_TASKS,
  parseJudgeExpectation,
  parseJudgeVerdicts,
} from "./lifeops-judge-scorer.js";

/**
 * Unit coverage for the judge-based LifeOps scorer (#11384). The judge
 * transport is injected, so these tests exercise the real prompt building,
 * strict parsing, retry, and aggregation logic — the live grading itself is
 * proven by the recorded GEPA runs in the issue evidence.
 */

const EXPECTATION = encodeJudgeExpectation({
  reference: "Trash night — bins out before 7.",
  rubric: ["Mentions the trash.", "Is one or two sentences.", "No emoji."],
});

function clientReturning(
  texts: string[],
): (req: CerebrasChatRequest) => Promise<CerebrasChatResponse> {
  let call = 0;
  return async () => {
    const text = texts[Math.min(call, texts.length - 1)] ?? "";
    call += 1;
    return { text };
  };
}

describe("LIFEOPS_JUDGE_TASKS", () => {
  it("names exactly the four prose/NL capabilities", () => {
    expect([...LIFEOPS_JUDGE_TASKS].sort()).toEqual([
      "meeting_prep",
      "morning_brief",
      "reminder_dispatch",
      "screentime_recap",
    ]);
  });
});

describe("parseJudgeExpectation", () => {
  it("round-trips an encoded expectation", () => {
    const parsed = parseJudgeExpectation(EXPECTATION);
    expect(parsed.reference).toContain("Trash night");
    expect(parsed.rubric).toHaveLength(3);
  });

  it("throws on non-JSON expected output", () => {
    expect(() => parseJudgeExpectation("just a sentence")).toThrow(/not JSON/);
  });

  it("throws on a missing or empty rubric", () => {
    expect(() =>
      parseJudgeExpectation(JSON.stringify({ reference: "x", rubric: [] })),
    ).toThrow(/at least one/);
    expect(() =>
      parseJudgeExpectation(JSON.stringify({ reference: "x" })),
    ).toThrow(/reference: string, rubric: string\[\]/);
  });
});

describe("buildLifeOpsJudgePrompt", () => {
  it("numbers rubric items and pins the reply contract to the rubric length", () => {
    const prompt = buildLifeOpsJudgePrompt({
      task: "reminder_dispatch",
      actual: "Bins out tonight!",
      expectation: parseJudgeExpectation(EXPECTATION),
    });
    expect(prompt).toContain('task "reminder_dispatch"');
    expect(prompt).toContain("1. Mentions the trash.");
    expect(prompt).toContain("3. No emoji.");
    expect(prompt).toContain("exactly 3 entries");
    expect(prompt).toContain("Bins out tonight!");
  });

  it("labels an empty completion instead of sending blank text", () => {
    const prompt = buildLifeOpsJudgePrompt({
      task: "morning_brief",
      actual: "   ",
      expectation: parseJudgeExpectation(EXPECTATION),
    });
    expect(prompt).toContain("(empty completion)");
  });
});

describe("parseJudgeVerdicts", () => {
  it("parses a clean verdict list", () => {
    const verdicts = parseJudgeVerdicts(
      JSON.stringify({
        items: [
          { index: 1, pass: true, reason: "mentions trash" },
          { index: 2, pass: false, reason: "three sentences" },
          { index: 3, pass: true, reason: "no emoji" },
        ],
      }),
      3,
    );
    expect(verdicts.map((v) => v.pass)).toEqual([true, false, true]);
  });

  it("parses verdicts wrapped in code fences and prose", () => {
    const raw = [
      "Here is my grading:",
      "```json",
      JSON.stringify({
        items: [
          { index: 1, pass: true, reason: "" },
          { index: 2, pass: true, reason: "" },
          { index: 3, pass: true, reason: "" },
        ],
      }),
      "```",
    ].join("\n");
    expect(parseJudgeVerdicts(raw, 3).every((v) => v.pass)).toBe(true);
  });

  it("throws on an item-count mismatch", () => {
    expect(() =>
      parseJudgeVerdicts(
        JSON.stringify({ items: [{ index: 1, pass: true }] }),
        3,
      ),
    ).toThrow(/1 items, expected 3/);
  });

  it("throws on a non-boolean pass verdict", () => {
    expect(() =>
      parseJudgeVerdicts(
        JSON.stringify({
          items: [
            { index: 1, pass: "yes" },
            { index: 2, pass: true },
            { index: 3, pass: true },
          ],
        }),
        3,
      ),
    ).toThrow(/not a boolean/);
  });

  it("throws when no JSON object exists in the reply", () => {
    expect(() => parseJudgeVerdicts("I cannot grade this.", 3)).toThrow(
      /no JSON object/,
    );
  });
});

describe("createLifeOpsJudgeCompare", () => {
  it("returns the fraction of rubric items passed", async () => {
    const compare = createLifeOpsJudgeCompare(
      "reminder_dispatch",
      clientReturning([
        JSON.stringify({
          items: [
            { index: 1, pass: true, reason: "" },
            { index: 2, pass: true, reason: "" },
            { index: 3, pass: false, reason: "emoji present" },
          ],
        }),
      ]),
    );
    await expect(compare("Bins out tonight! 🗑️", EXPECTATION)).resolves.toBe(
      2 / 3,
    );
  });

  it("retries once on an unparsable judge reply, then succeeds", async () => {
    const compare = createLifeOpsJudgeCompare(
      "morning_brief",
      clientReturning([
        "sorry, no JSON",
        JSON.stringify({
          items: [
            { index: 1, pass: true, reason: "" },
            { index: 2, pass: true, reason: "" },
            { index: 3, pass: true, reason: "" },
          ],
        }),
      ]),
    );
    await expect(compare("A fine brief.", EXPECTATION)).resolves.toBe(1);
  });

  it("throws (never silently defaults) when the judge stays unparsable", async () => {
    const compare = createLifeOpsJudgeCompare(
      "screentime_recap",
      clientReturning(["garbage", "more garbage"]),
    );
    await expect(compare("anything", EXPECTATION)).rejects.toThrow(
      /no JSON object/,
    );
  });
});
