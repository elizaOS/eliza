/** Tests typed scenario manifests, per-attempt isolation, and model-free claims. */

import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import {
  createDeterministicModelFixtureRegistry,
  type DeterministicModelFixtureRegistry,
} from "@elizaos/core/testing";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";
import {
  beginScenarioModelFixtureAttempt,
  compileScenarioModelFixture,
  scenarioModelFixtureMode,
} from "./model-fixtures.ts";

function runtimeWithRegistry(registry: DeterministicModelFixtureRegistry) {
  return { scenarioModelFixtures: registry } as unknown as AgentRuntime;
}

function call(input: string) {
  return {
    modelType: ModelType.TEXT_SMALL,
    latestUserText: input,
    toolNames: ["ONE", "TWO"],
    params: { prompt: `prompt:${input}` },
  };
}

describe("scenario model fixture manifests", () => {
  it("compiles serializable exact/includes/pattern matchers and structured output", () => {
    const registry = createDeterministicModelFixtureRegistry([
      compileScenarioModelFixture({
        name: "structured",
        match: {
          modelType: ModelType.TEXT_SMALL,
          input: { exact: "hello" },
          prompt: { pattern: "^prompt:", flags: "i" },
          toolNames: ["ONE", "TWO"],
        },
        response: {
          text: "done",
          finishReason: "tool-calls",
          toolCalls: [{ name: "ONE", arguments: { value: 1 } }],
        },
        cardinality: 1,
      }),
    ]);
    const resolution = registry.resolve(call("hello"));
    expect(JSON.parse(resolution.response)).toMatchObject({
      text: "done",
      finishReason: "tool-calls",
      toolCalls: [{ name: "ONE", arguments: { value: 1 } }],
    });
    expect(() => registry.assertConsumed()).not.toThrow();
  });

  it("starts each attempt with independent consumption and scope", () => {
    const registry = createDeterministicModelFixtureRegistry();
    const runtime = runtimeWithRegistry(registry);
    const scenario = {
      id: "fixture.attempt",
      title: "Attempt fixture",
      domain: "fixture",
      turns: [{ kind: "message", name: "ask", text: "hello" }],
      modelFixtures: {
        mode: "fixtures",
        fixtures: [
          {
            name: "answer",
            match: {
              modelType: ModelType.TEXT_SMALL,
              input: { exact: "hello" },
            },
            response: { text: "hi" },
            cardinality: 1,
          },
        ],
      },
    } satisfies ScenarioDefinition;

    beginScenarioModelFixtureAttempt(runtime, scenario, "attempt-1", "world-a");
    registry.resolve(call("hello"));
    expect(registry.diagnostics().fixtures[0]?.consumed).toBe(1);

    beginScenarioModelFixtureAttempt(runtime, scenario, "attempt-2", "world-b");
    expect(registry.diagnostics()).toMatchObject({
      scope: {
        scenarioId: "fixture.attempt",
        attemptId: "attempt-2",
        worldId: "world-b",
      },
      fixtures: [{ consumed: 0 }],
      calls: [],
    });
  });

  it.each(["g", "y"])(
    "keeps scenario /%s regex matchers deterministic across repeated calls",
    (flags) => {
      const registry = createDeterministicModelFixtureRegistry([
        compileScenarioModelFixture({
          name: `stateful-${flags}`,
          match: {
            modelType: ModelType.TEXT_SMALL,
            input: { pattern: "hello", flags },
          },
          response: { text: "hi" },
          cardinality: 2,
        }),
      ]);

      expect(registry.resolve(call("hello")).response).toBe("hi");
      expect(registry.resolve(call("hello")).response).toBe("hi");
      expect(() => registry.assertConsumed()).not.toThrow();
    },
  );

  it("accepts direct action/API model-free scenarios and rejects hidden model paths", () => {
    const registry = createDeterministicModelFixtureRegistry();
    const runtime = runtimeWithRegistry(registry);
    const direct = {
      id: "fixture.direct",
      title: "Direct fixture",
      domain: "fixture",
      turns: [
        { kind: "action", name: "act", action: "PING" },
        { kind: "api", name: "api", path: "/ping" },
      ],
      modelFixtures: { mode: "model-free", reason: "Direct contract calls" },
    } as unknown as ScenarioDefinition;
    expect(() =>
      beginScenarioModelFixtureAttempt(runtime, direct, "attempt-1"),
    ).not.toThrow();

    const conversational = {
      ...direct,
      id: "fixture.hidden-model",
      turns: [{ kind: "message", name: "ask", text: "hello" }],
    } as ScenarioDefinition;
    expect(() =>
      beginScenarioModelFixtureAttempt(runtime, conversational, "attempt-1"),
    ).toThrow(/declares model-free but contains model-backed work/);
  });

  it("reports strict versus legacy migration modes without guessing", () => {
    expect(scenarioModelFixtureMode({})).toBe("legacy-fallback");
    expect(
      scenarioModelFixtureMode({
        modelFixtures: { mode: "fixtures", fixtures: [] },
      }),
    ).toBe("strict-fixtures");
    expect(
      scenarioModelFixtureMode({
        modelFixtures: { mode: "model-free", reason: "direct API" },
      }),
    ).toBe("model-free");
  });
});
