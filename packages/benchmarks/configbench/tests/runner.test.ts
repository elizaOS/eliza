import { describe, expect, it } from "vitest";
import { runBenchmark } from "../src/runner.js";
import type { Handler, Scenario } from "../src/types.js";

function scenario(id: string): Scenario {
  return {
    id,
    name: id,
    category: "secrets-crud",
    description: "runner failure handling",
    channel: "dm",
    messages: [{ from: "user", text: "run" }],
    groundTruth: {},
    checks: [
      {
        name: "no handler error",
        severity: "critical",
        evaluate: (outcome) => ({
          passed: !outcome.error,
          expected: "handler completed",
          actual: outcome.error ?? "handler completed",
        }),
      },
    ],
  };
}

describe("runBenchmark", () => {
  it("records thrown scenario runs as failed outcomes and still tears down", async () => {
    let teardownCalled = false;
    const throwingHandler: Handler = {
      name: "ThrowingHandler",
      async run() {
        throw new Error("scenario exploded");
      },
      async teardown() {
        teardownCalled = true;
      },
    };

    const results = await runBenchmark(throwingHandler ? [throwingHandler] : [], [
      scenario("s1"),
    ]);
    const scored = results.handlers[0]?.scenarios[0];

    expect(teardownCalled).toBe(true);
    expect(scored?.passed).toBe(false);
    expect(scored?.traces[0]).toContain("scenario exploded");
  });
});
