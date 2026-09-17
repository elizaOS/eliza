/** Exercises fixture ownership with real PGlite, evaluator persistence, and TaskService timers. */
import type { AgentRuntime } from "@elizaos/core";
import type { DeterministicModelFixtureRegistry } from "@elizaos/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import echoScenario from "../../test/scenarios/convo/echo-self-test.scenario";
import greetingScenario from "../../test/scenarios/convo/greeting-dynamic.scenario";
import { runScenario } from "./executor";
import {
  createScenarioRuntime,
  type RuntimeFactoryResult,
} from "./runtime-factory";
import { drainScenarioBackgroundMemory } from "./scenario-background-memory";

function registry(runtime: AgentRuntime): DeterministicModelFixtureRegistry {
  const value = (
    runtime as AgentRuntime & {
      scenarioModelFixtures?: DeterministicModelFixtureRegistry;
    }
  ).scenarioModelFixtures;
  if (!value) throw new Error("Deterministic fixture registry is unavailable.");
  return value;
}

describe("durable scenario memory ownership", () => {
  let result: RuntimeFactoryResult;
  beforeEach(async () => {
    result = await createScenarioRuntime({ useDeterministicModel: true });
  }, 120_000);
  afterEach(async () => {
    await result?.cleanup();
  }, 120_000);

  function options(postDeliveryTimeoutMs = 30_000) {
    return {
      providerName: result.providerName,
      minJudgeScore: 0.8,
      turnTimeoutMs: 30_000,
      postDeliveryTimeoutMs,
    };
  }

  it("completes required typed memory before a second scenario replaces its fixtures", async () => {
    const fixtures = registry(result.runtime);
    const register = fixtures.register.bind(fixtures);
    // Only the deterministic model response is delayed; the real worker,
    // persistence, processing and scheduler remain the system under test.
    fixtures.register = (...items) =>
      register(
        ...items.map((item) =>
          item.name.startsWith("memory-")
            ? { ...item, behavior: { latencyMs: 150 } }
            : item,
        ),
      );
    const first = await runScenario(echoScenario, result.runtime, options());
    expect(first.status, JSON.stringify(first.failedAssertions)).toBe("passed");
    expect(first.modelFixtureDiagnostics?.fixtures).toContainEqual(
      expect.objectContaining({
        name: "memory-echo-typed-completion",
        consumed: 1,
        required: true,
      }),
    );
    expect(await result.runtime.getTasksByName("POST_TURN_MEMORY")).toEqual([]);
    const second = await runScenario(
      greetingScenario,
      result.runtime,
      options(),
    );
    expect(second.status, JSON.stringify(second.failedAssertions)).toBe(
      "passed",
    );
    expect(second.modelFixtureDiagnostics?.unexpectedCalls).toEqual([]);
    expect(second.modelFixtureDiagnostics?.fixtures).toContainEqual(
      expect.objectContaining({
        name: "memory-greeting-typed-completion",
        consumed: 1,
        required: true,
      }),
    );
    expect(await result.runtime.getTasksByName("POST_TURN_MEMORY")).toEqual([]);
  }, 120_000);

  it("attributes malformed memory to its origin and refuses to replace the registry", async () => {
    const fixtures = registry(result.runtime);
    const register = fixtures.register.bind(fixtures);
    fixtures.register = (...items) =>
      register(
        ...items.map((item) =>
          item.name === "memory-echo-typed-completion"
            ? { ...item, response: {} }
            : item,
        ),
      );
    const first = await runScenario(echoScenario, result.runtime, options());
    expect(first.status).toBe("failed");
    expect(first.failedAssertions).toContainEqual(
      expect.objectContaining({ label: "postDeliveryTasks" }),
    );
    expect(first.modelFixtureDiagnostics?.fixtures).toContainEqual(
      expect.objectContaining({
        name: "memory-echo-typed-completion",
        consumed: 1,
        required: true,
      }),
    );
    expect(first.modelFixtureDiagnostics?.unexpectedCalls).toEqual([]);
    const tasks = await result.runtime.getTasksByName("POST_TURN_MEMORY");
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.some((task) => Number(task.metadata?.failureCount) > 0)).toBe(
      true,
    );
    const originalScope = fixtures.diagnostics().scope;
    const second = await runScenario(
      greetingScenario,
      result.runtime,
      options(),
    );
    expect(second.status).toBe("failed");
    expect(second.failedAssertions).toContainEqual(
      expect.objectContaining({ label: "runtimeIsolation" }),
    );
    expect(fixtures.diagnostics().scope).toEqual(originalScope);
  }, 120_000);

  it("bounds pending real work without handing its registry to another scenario", async () => {
    const fixtures = registry(result.runtime);
    const register = fixtures.register.bind(fixtures);
    fixtures.register = (...items) =>
      register(
        ...items.map((item) =>
          item.name === "memory-echo-typed-completion"
            ? { ...item, behavior: { latencyMs: 3_000 } }
            : item,
        ),
      );
    const first = await runScenario(echoScenario, result.runtime, options(100));
    expect(first.status).toBe("failed");
    expect(first.failedAssertions).toContainEqual(
      expect.objectContaining({ label: "postDeliveryTasks" }),
    );
    expect(
      (await result.runtime.getTasksByName("POST_TURN_MEMORY")).length,
    ).toBeGreaterThan(0);
    const scope = fixtures.diagnostics().scope;
    const second = await runScenario(
      greetingScenario,
      result.runtime,
      options(),
    );
    expect(second.failedAssertions).toContainEqual(
      expect.objectContaining({ label: "runtimeIsolation" }),
    );
    expect(fixtures.diagnostics().scope).toEqual(scope);
  }, 120_000);
  it("refuses a pre-existing paused job before adopting any scenario fixtures", async () => {
    const fixtures = registry(result.runtime);
    const scope = fixtures.diagnostics().scope;
    await result.runtime.createTask({
      name: "POST_TURN_MEMORY",
      agentId: result.runtime.agentId,
      tags: ["queue", "repeat"],
      metadata: { paused: true },
    });
    const report = await runScenario(echoScenario, result.runtime, options());
    expect(report.status).toBe("failed");
    expect(report.failedAssertions).toContainEqual(
      expect.objectContaining({ label: "runtimeIsolation" }),
    );
    expect(fixtures.diagnostics().scope).toEqual(scope);
    expect(
      (await result.runtime.getTasksByName("POST_TURN_MEMORY"))[0].metadata
        ?.paused,
    ).toBe(true);
  }, 120_000);
  it("interrupts an in-flight durable read when the caller aborts", async () => {
    const originalRead = result.runtime.getTasksByName.bind(result.runtime);
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let readReleased = false;
    let releaseRead: () => void = () => undefined;
    const heldRead = new Promise<Awaited<ReturnType<typeof originalRead>>>(
      (resolve) => {
        releaseRead = () => {
          readReleased = true;
          resolve([]);
        };
      },
    );
    result.runtime.getTasksByName = async () => {
      markStarted();
      return heldRead;
    };
    const caller = new AbortController();
    // This deadline never fires: rejection must come from caller cancellation.
    const readDeadline = new AbortController();
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const draining = drainScenarioBackgroundMemory(
        result.runtime,
        caller.signal,
        readDeadline.signal,
      );
      await started;
      caller.abort(new Error("Caller cancelled the stalled query"));
      // The old drain would wait for this read and fabricate idle success.
      // Releasing it also keeps the failing regression bounded without leaving
      // an unresolved persistence fault behind during real runtime teardown.
      releaseTimer = setTimeout(releaseRead, 250);
      await expect(draining).rejects.toMatchObject({
        cause: caller.signal.reason,
      });
      expect(readReleased).toBe(false);
    } finally {
      if (releaseTimer) clearTimeout(releaseTimer);
      releaseRead();
      result.runtime.getTasksByName = originalRead;
    }
  }, 120_000);
  it("finishes a delayed durable turn before the next fixture-owned message starts", async () => {
    const fixtures = registry(result.runtime);
    const register = fixtures.register.bind(fixtures);
    let firstMemoryProduced = false;
    let nextMessageSawCompletion = false;
    let nextMessageTasks:
      | ReturnType<AgentRuntime["getTasksByName"]>
      | undefined;
    fixtures.register = (...items) =>
      register(
        ...items.map((item) => {
          if (item.name === "memory-echo-typed-completion") {
            const response = item.response;
            return {
              ...item,
              behavior: { latencyMs: 1500 },
              response: (call) => {
                firstMemoryProduced = true;
                return typeof response === "function"
                  ? response(call)
                  : response;
              },
            };
          }
          if (item.name.startsWith("route-greet-user-stage1")) {
            const response = item.response;
            return {
              ...item,
              response: (call) => {
                nextMessageSawCompletion = firstMemoryProduced;
                nextMessageTasks =
                  result.runtime.getTasksByName("POST_TURN_MEMORY");
                return typeof response === "function"
                  ? response(call)
                  : response;
              },
            };
          }
          return item;
        }),
      );
    const report = await runScenario(
      {
        ...echoScenario,
        seed: [...(echoScenario.seed ?? []), ...(greetingScenario.seed ?? [])],
        turns: [...echoScenario.turns, ...greetingScenario.turns],
        finalChecks: [
          ...(echoScenario.finalChecks ?? []),
          ...(greetingScenario.finalChecks ?? []),
        ],
      },
      result.runtime,
      options(),
    );
    expect(nextMessageSawCompletion).toBe(true);
    expect(report.status, JSON.stringify(report.failedAssertions)).toBe(
      "passed",
    );
    expect(nextMessageTasks).toBeDefined();
    expect(await nextMessageTasks).toEqual([]);
    expect(report.modelFixtureDiagnostics?.unexpectedCalls).toEqual([]);
    expect(await result.runtime.getTasksByName("POST_TURN_MEMORY")).toEqual([]);
  }, 120_000);

  it("does not dispatch the next message after its predecessor's durable evaluation fails", async () => {
    const fixtures = registry(result.runtime);
    const register = fixtures.register.bind(fixtures);
    fixtures.register = (...items) =>
      register(
        ...items.map((item) =>
          item.name === "memory-echo-typed-completion"
            ? { ...item, response: {} }
            : item,
        ),
      );
    const report = await runScenario(
      {
        ...echoScenario,
        seed: [...(echoScenario.seed ?? []), ...(greetingScenario.seed ?? [])],
        turns: [...echoScenario.turns, ...greetingScenario.turns],
      },
      result.runtime,
      options(),
    );
    expect(report.status).toBe("failed");
    expect(report.failedAssertions).toContainEqual(
      expect.objectContaining({ label: "postDeliveryTasks" }),
    );
    expect(report.modelFixtureDiagnostics?.fixtures).toContainEqual(
      expect.objectContaining({
        name: "memory-echo-typed-completion",
        consumed: 1,
      }),
    );
    expect(report.turns).toHaveLength(1);
    expect(
      report.actionsCalled.some((action) => action.actionName === "GREET_USER"),
    ).toBe(false);
    expect(
      (await result.runtime.getTasksByName("POST_TURN_MEMORY")).some(
        (task) => Number(task.metadata?.failureCount) > 0,
      ),
    ).toBe(true);
  }, 120_000);
});
