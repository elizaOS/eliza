/** Executes all 13 external mutants against their package-owned production seams. */

import {
  PROGRESSIVE_CONTENT_REQUIRED_MUTANTS,
  type ProgressiveContentExternalMutantId,
} from "@elizaos/core/testing";
import { describe, expect, it } from "vitest";
import { createProgressiveContentExternalMutantExecutors } from "./progressive-content-external-mutants.ts";

describe("progressive-content external mutant executors", () => {
  it("has an executable oracle for every non-adapter registry member", async () => {
    const executors = createProgressiveContentExternalMutantExecutors();
    const external = PROGRESSIVE_CONTENT_REQUIRED_MUTANTS.filter(
      ({ executor }) => executor !== "adapter",
    );
    expect(Object.keys(executors).sort()).toEqual(
      external.map(({ id }) => id).sort(),
    );
    for (const mutant of external) {
      await expect(
        Promise.resolve().then(() =>
          executors[mutant.id as ProgressiveContentExternalMutantId].execute(),
        ),
      ).rejects.toMatchObject({ vector: mutant.killingVector });
    }
  });
});
