import { describe, expect, it } from "vitest";
import { runBenchmark } from "../src/runner.js";
import { setupIncompatible } from "../src/setup-incompatible.js";
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

    const results = await runBenchmark(
      throwingHandler ? [throwingHandler] : [],
      [scenario("s1")],
    );
    const scored = results.handlers[0]?.scenarios[0];

    expect(teardownCalled).toBe(true);
    expect(scored?.passed).toBe(false);
    expect(scored?.traces[0]).toContain("scenario exploded");
  });

  it("excludes setup-incompatible handlers from scored results", async () => {
    let runCalled = false;
    let teardownCalled = false;
    const incompatibleHandler: Handler = {
      name: "Eliza (LLM Agent)",
      async setup() {
        throw setupIncompatible(
          "Eliza setup incompatible: TEXT_EMBEDDING probe failed",
        );
      },
      async run() {
        runCalled = true;
        throw new Error("should not run");
      },
      async teardown() {
        teardownCalled = true;
      },
    };

    const results = await runBenchmark(
      incompatibleHandler ? [incompatibleHandler] : [],
      [scenario("s1")],
    );

    expect(runCalled).toBe(false);
    expect(teardownCalled).toBe(true);
    expect(results.handlers).toHaveLength(0);
    expect(results.setupIncompatibleHandlers).toEqual([
      {
        handlerName: "Eliza (LLM Agent)",
        reason: "Eliza setup incompatible: TEXT_EMBEDDING probe failed",
        traces: [
          "SETUP_INCOMPATIBLE: Eliza setup incompatible: TEXT_EMBEDDING probe failed",
        ],
      },
    ]);
  });
});
