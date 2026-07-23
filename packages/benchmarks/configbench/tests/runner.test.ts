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
  it("fails closed when a majority of scenarios throw, and still tears down", async () => {
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

    // Every scenario throws → 100% failure → systemic transport guard fires.
    await expect(
      runBenchmark([throwingHandler], [scenario("s1"), scenario("s2")]),
    ).rejects.toThrow("transport failure");

    expect(teardownCalled).toBe(true);
  });

  it("scores a single failed scenario wrong and completes the rest", async () => {
    let calls = 0;
    const flakyHandler: Handler = {
      name: "FlakyHandler",
      async run(input) {
        calls += 1;
        if (input.id === "s2") {
          throw new Error("no JSON decision text");
        }
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
    };

    // 1 of 4 fails (25% < 50%) → run completes; the failed scenario is scored
    // (a capability miss), not dropped and not a whole-run abort.
    const results = await runBenchmark([flakyHandler], [
      scenario("s1"),
      scenario("s2"),
      scenario("s3"),
      scenario("s4"),
    ]);
    expect(calls).toBe(4);
    const handler = results.handlers[0];
    expect(handler.scenarios).toHaveLength(4);
    const failed = handler.scenarios.find((s) => s.scenarioId === "s2");
    expect(failed).toBeDefined();
    expect(failed?.passed).toBe(false);
    expect(failed?.traces.join(" ")).toContain("SCENARIO_FAILED");
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
