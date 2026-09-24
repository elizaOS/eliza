/**
 * Corpus + fixture + committed-baseline invariants for the triage benchmark.
 * Pure (no runtime, no classifier import): recomputes the recorded scores
 * from the committed corpus/fixtures and pins them against baseline.json and
 * budgets.json, so a drifted commit fails the cheap unit lane before the
 * gate lane ever runs.
 */

import { describe, expect, it } from "vitest";
import baseline from "../baseline.json";
import budgets from "../budgets.json";
import { PRIORITY_SENDERS, TRIAGE_CLASSES, TRIAGE_CORPUS } from "./corpus.ts";
import { TRIAGE_FIXTURES } from "./fixtures.ts";
import { scoreTriage } from "./metrics.ts";

/** The seven documented deliberate model errors (fixtures.ts header). */
const DELIBERATE_ERRORS: Record<string, string> = {
  "ig-03": "info",
  "ig-08": "needs_reply",
  "in-03": "notify",
  "no-08": "info",
  "no-09": "info",
  "nr-06": "info",
  "ur-10": "needs_reply",
};

function normalizedFixtureClass(id: string): string {
  const fixture = TRIAGE_FIXTURES[id];
  if (!fixture) throw new Error(`missing fixture for ${id}`);
  return fixture.classification.trim().toLowerCase();
}

describe("triage corpus invariants", () => {
  it("has 56 unique items with the documented class distribution", () => {
    expect(TRIAGE_CORPUS).toHaveLength(56);
    const ids = new Set(TRIAGE_CORPUS.map((item) => item.id));
    expect(ids.size).toBe(TRIAGE_CORPUS.length);
    const counts: Record<string, number> = {};
    for (const item of TRIAGE_CORPUS) {
      counts[item.gold] = (counts[item.gold] ?? 0) + 1;
    }
    expect(counts).toEqual({
      ignore: 12,
      info: 10,
      notify: 10,
      needs_reply: 14,
      urgent: 10,
    });
  });

  it("keeps realistic bodies whose prompt-scalar form is unique (the mock model keys on it)", () => {
    const scalars = new Set<string>();
    for (const item of TRIAGE_CORPUS) {
      expect(item.text.length, `${item.id} body too thin`).toBeGreaterThan(40);
      const scalar = item.text.replace(/\s+/g, " ").trim().slice(0, 500);
      expect(scalars.has(scalar), `${item.id} duplicates another body`).toBe(
        false,
      );
      scalars.add(scalar);
    }
  });

  it("pairs every corpus item with exactly one valid fixture answer and no orphans", () => {
    const corpusIds = new Set(TRIAGE_CORPUS.map((item) => item.id));
    expect(new Set(Object.keys(TRIAGE_FIXTURES))).toEqual(corpusIds);
    const validClasses = new Set<string>(TRIAGE_CLASSES);
    for (const [id, fixture] of Object.entries(TRIAGE_FIXTURES)) {
      expect(
        validClasses.has(fixture.classification.trim().toLowerCase()),
        `${id} classification`,
      ).toBe(true);
      expect(
        ["low", "medium", "high"].includes(
          fixture.urgency.trim().toLowerCase(),
        ),
        `${id} urgency`,
      ).toBe(true);
      const confidence = Number(fixture.confidence);
      expect(Number.isFinite(confidence), `${id} confidence`).toBe(true);
      expect(confidence).toBeGreaterThanOrEqual(0);
      expect(confidence).toBeLessThanOrEqual(1);
      expect(fixture.reasoning.length, `${id} reasoning`).toBeGreaterThan(0);
    }
  });

  it("mismatches gold on exactly the seven documented deliberate errors", () => {
    const mismatches: Record<string, string> = {};
    for (const item of TRIAGE_CORPUS) {
      const predicted = normalizedFixtureClass(item.id);
      if (predicted !== item.gold) mismatches[item.id] = predicted;
    }
    expect(mismatches).toEqual(DELIBERATE_ERRORS);
  });

  it("names real priority senders that appear in the corpus", () => {
    const senders = new Set(TRIAGE_CORPUS.map((item) => item.senderName));
    for (const sender of PRIORITY_SENDERS) {
      expect(senders.has(sender), `${sender} not in corpus`).toBe(true);
    }
  });
});

describe("committed baseline + budgets consistency", () => {
  const recomputed = scoreTriage(
    TRIAGE_CLASSES,
    TRIAGE_CORPUS.map((item) => item.gold),
    TRIAGE_CORPUS.map((item) => normalizedFixtureClass(item.id)),
  );

  it("baseline.json triage block is exactly the corpus×fixtures score", () => {
    expect(recomputed.total).toBe(baseline.triage.corpusSize);
    expect(recomputed.correct).toBe(baseline.triage.correct);
    expect(recomputed.accuracy).toBe(baseline.triage.accuracy);
    expect(recomputed.macroF1).toBe(baseline.triage.macroF1);
    for (const label of TRIAGE_CLASSES) {
      const measured = recomputed.perClass[label];
      const recorded =
        baseline.triage.perClass[
          label as keyof typeof baseline.triage.perClass
        ];
      expect(measured?.precision, `${label} precision`).toBe(
        recorded.precision,
      );
      expect(measured?.recall, `${label} recall`).toBe(recorded.recall);
      expect(measured?.f1, `${label} f1`).toBe(recorded.f1);
      expect(measured?.goldCount, `${label} goldCount`).toBe(
        recorded.goldCount,
      );
      expect(measured?.predictedCount, `${label} predictedCount`).toBe(
        recorded.predictedCount,
      );
    }
  });

  it("the recorded baseline satisfies every committed budget floor", () => {
    const floors = budgets.triage;
    expect(baseline.triage.accuracy).toBeGreaterThanOrEqual(floors.minAccuracy);
    expect(baseline.triage.macroF1).toBeGreaterThanOrEqual(floors.minMacroF1);
    for (const label of TRIAGE_CLASSES) {
      const recorded =
        baseline.triage.perClass[
          label as keyof typeof baseline.triage.perClass
        ];
      const floor = floors.perClass[label as keyof typeof floors.perClass];
      expect(
        recorded.precision,
        `${label} precision floor`,
      ).toBeGreaterThanOrEqual(floor.minPrecision);
      expect(recorded.recall, `${label} recall floor`).toBeGreaterThanOrEqual(
        floor.minRecall,
      );
    }
  });

  it("budget floors trip on one additional misclassification per class", () => {
    const floors = budgets.triage;
    // One more false negative on a class drops its recall to
    // (tp-1)/gold; one more false positive drops precision to tp/(pred+1).
    for (const label of TRIAGE_CLASSES) {
      const cls = recomputed.perClass[label];
      const floor = floors.perClass[label as keyof typeof floors.perClass];
      if (!cls || !floor) throw new Error(`missing class ${label}`);
      const recallAfterOneMiss = (cls.truePositives - 1) / cls.goldCount;
      const precisionAfterOneFalsePositive =
        cls.truePositives / (cls.predictedCount + 1);
      expect(
        recallAfterOneMiss,
        `${label} recall floor would not trip on one extra miss`,
      ).toBeLessThan(floor.minRecall);
      expect(
        precisionAfterOneFalsePositive,
        `${label} precision floor would not trip on one extra false positive`,
      ).toBeLessThan(floor.minPrecision);
    }
    const accuracyAfterOneMore = (recomputed.correct - 1) / recomputed.total;
    expect(accuracyAfterOneMore).toBeLessThan(floors.minAccuracy);
  });
});
