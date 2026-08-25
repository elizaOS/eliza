/**
 * Verifies strict scenario evaluator isolation restores the exact shared
 * registry once, including when cleanup retries.
 */
import { describe, expect, it } from "vitest";
import { isolatePostTurnEvaluators } from "../../test/scenarios/_helpers/post-turn-evaluator-isolation";

describe("post-turn evaluator isolation", () => {
  it("restores the original evaluator array idempotently", () => {
    const evaluators = [{ name: "reflection" }, { name: "facts" }];
    const runtime = { evaluators };
    const restore = isolatePostTurnEvaluators(runtime);

    expect(runtime.evaluators).toEqual([]);
    restore();
    restore();

    expect(runtime.evaluators).toBe(evaluators);
  });
});
