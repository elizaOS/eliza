import { expect, test } from "bun:test";
import { protectedStageOperator } from "./pitr-stage-operator";

test("unprotected invocation refuses with no effect or provider execution", async () => {
  const previous = process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_ACTIONS;
  try {
    expect(await protectedStageOperator(new AbortController().signal)).toEqual({
      purpose: "production_pitr_stage_only",
      state: "refused_before_stage",
      resourceCreationPossible: false,
      automaticRetryAllowed: false,
      committed: false,
      productionMigrationReady: false,
    });
  } finally {
    if (previous !== undefined) process.env.GITHUB_ACTIONS = previous;
  }
});
