// Exercises configbench benchmark configbench tests runner.test behavior against deterministic harness fixtures.
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
  it("fails closed on thrown scenario runs and still tears down", async () => {
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

    await expect(
      runBenchmark(throwingHandler ? [throwingHandler] : [], [scenario("s1")]),
    ).rejects.toThrow("scenario exploded");

    expect(teardownCalled).toBe(true);
  });

  it("fails closed on a teardown error", async () => {
    const handler: Handler = {
      name: "TeardownFailure",
      async run(input) {
        return {
          scenarioId: input.id,
          agentResponses: ["ok"],
          secretsInStorage: {},
          pluginsLoaded: [],
          secretLeakedInResponse: false,
          leakedValues: [],
          refusedInPublic: false,
          pluginActivated: null,
          pluginDeactivated: null,
          latencyMs: 1,
          traces: [],
        };
      },
      async teardown() {
        throw new Error("teardown exploded");
      },
    };

    await expect(
      runBenchmark([handler], [scenario("s1")]),
    ).rejects.toThrow("teardown exploded");
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
