import { describe, expect, it } from "vitest";
import {
  parseBoundedIntegerArg,
  SEED_TASKS,
  validatePersistableResult,
} from "../../scripts/lifeops-gepa-seed.ts";
import type { OptimizerResult } from "../optimizers/index.js";

function makeResult(
  seedPrompt: string,
  score: number,
  baseline: number,
): OptimizerResult {
  return {
    optimizedPrompt: seedPrompt,
    score,
    baseline,
    lineage: [],
  };
}

describe("lifeops-gepa-seed", () => {
  it("uses the live calendar planner baseline and schema-shaped examples", () => {
    const seed = SEED_TASKS.calendar_extract;
    expect(seed.baseline).toContain("Plan the calendar action");
    expect(seed.baseline).toContain("subaction");
    expect(seed.baseline).toContain("timeMin");

    for (const example of seed.dataset) {
      expect(example.input.user).toContain("LOCAL DATE ANCHORS");
      expect(example.input.user).toContain("Current request:");

      const parsed = JSON.parse(example.expectedOutput) as Record<
        string,
        unknown
      >;
      expect(parsed).toHaveProperty("subaction");
      expect(parsed).toHaveProperty("shouldAct");
      expect(parsed).not.toHaveProperty("date");
      expect(parsed).not.toHaveProperty("startTime");
      expect(parsed).not.toHaveProperty("endTime");
    }
  });

  it("validates numeric CLI bounds", () => {
    expect(
      parseBoundedIntegerArg("generations", undefined, {
        defaultValue: 2,
        min: 1,
        max: 20,
      }),
    ).toBe(2);
    expect(
      parseBoundedIntegerArg("generations", "3", {
        defaultValue: 2,
        min: 1,
        max: 20,
      }),
    ).toBe(3);
    expect(() =>
      parseBoundedIntegerArg("generations", "0", {
        defaultValue: 2,
        min: 1,
        max: 20,
      }),
    ).toThrow(/--generations/);
    expect(() =>
      parseBoundedIntegerArg("population", "2.5", {
        defaultValue: 4,
        min: 2,
        max: 50,
      }),
    ).toThrow(/--population/);
  });

  it("blocks non-improving or malformed calendar prompts from persistence", () => {
    const seed = SEED_TASKS.calendar_extract;
    const nonImproving = validatePersistableResult(
      seed,
      makeResult(seed.baseline, 0.5, 0.5),
    );
    expect(nonImproving).toEqual(
      expect.arrayContaining([
        expect.stringContaining("optimized score must beat baseline"),
      ]),
    );

    const malformed = validatePersistableResult(
      seed,
      makeResult("Return JSON with subaction and shouldAct.", 0.9, 0.1),
    );
    expect(malformed).toEqual(
      expect.arrayContaining([expect.stringContaining('"queries"')]),
    );

    expect(
      validatePersistableResult(seed, makeResult(seed.baseline, 0.9, 0.1)),
    ).toEqual([]);
  });
});
