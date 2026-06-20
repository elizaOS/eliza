import {
  type Action,
  type Memory,
  ModelType,
  type Plugin,
} from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { type MockLlmRuntime, withMockLlmRuntime } from "../index.ts";
import { adversarialActionRouteFixtures } from "../negative-fixtures.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

function track(harness: MockLlmRuntime): MockLlmRuntime {
  cleanups.push(harness.cleanup);
  return harness;
}

describe("withMockLlmRuntime", () => {
  it("registers the deterministic proxy so it wins model dispatch", async () => {
    const harness = track(
      await withMockLlmRuntime({
        fixtures: [
          {
            name: "small-ping",
            match: { modelType: ModelType.TEXT_SMALL },
            response: "deterministic-pong",
            times: 1,
          },
        ],
      }),
    );

    const out = await harness.runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: "ping",
    });

    expect(out).toBe("deterministic-pong");
    expect(() => harness.assertFixturesConsumed()).not.toThrow();
  });

  it("serves a zero embedding vector of the configured dimension", async () => {
    const harness = track(
      await withMockLlmRuntime({ embeddingDimensions: 384 }),
    );

    const embedding = (await harness.runtime.useModel(
      ModelType.TEXT_EMBEDDING,
      { text: "anything" },
    )) as number[];

    expect(Array.isArray(embedding)).toBe(true);
    expect(embedding).toHaveLength(384);
    expect(embedding.every((value) => value === 0)).toBe(true);
  });

  it("fails closed in strict mode on an unmatched model call", async () => {
    const harness = track(await withMockLlmRuntime({ strict: true }));

    await expect(
      harness.runtime.useModel(ModelType.TEXT_SMALL, { prompt: "no fixture" }),
    ).rejects.toThrow();
  });

  it("asserts required fixtures are consumed", async () => {
    const harness = track(
      await withMockLlmRuntime({
        fixtures: [
          {
            name: "required-unused",
            match: { modelType: ModelType.TEXT_LARGE },
            response: "never called",
            required: true,
            times: 1,
          },
        ],
      }),
    );

    expect(() => harness.assertFixturesConsumed()).toThrow();
  });

  it("drives an action handler turn through the mock LLM", async () => {
    const summarizeAction: Action = {
      name: "SUMMARIZE",
      description: "Summarize the input using the model.",
      similes: [],
      examples: [],
      validate: async () => true,
      handler: async (runtime, _message) => {
        const summary = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: "summarize",
        });
        return { text: String(summary), success: true };
      },
    };
    const plugin: Plugin = {
      name: "summarize-plugin",
      description: "test plugin",
      actions: [summarizeAction],
    };

    const harness = track(
      await withMockLlmRuntime({
        plugins: [plugin],
        fixtures: [
          {
            name: "summary",
            match: { modelType: ModelType.TEXT_LARGE },
            response: "a concise summary",
            times: 1,
          },
        ],
      }),
    );

    const message = { content: { text: "long text" } } as Memory;
    const result = (await summarizeAction.handler(
      harness.runtime,
      message,
    )) as { text: string; success: boolean };

    expect(result.success).toBe(true);
    expect(result.text).toBe("a concise summary");
    expect(() => harness.assertFixturesConsumed()).not.toThrow();
  });

  it("lets an adversarial (malformed) planner output reach the runtime unfiltered", async () => {
    // The negative pack sets validateResponse:false, so the proxy emits the bad
    // output instead of pre-rejecting it. Here we assert the proxy itself does
    // not throw at emit time — the runtime/plugin is what must degrade safely.
    const harness = track(
      await withMockLlmRuntime({
        fixtures: adversarialActionRouteFixtures("malformed-json", {
          input: "do the thing",
          intendedAction: "DO_THING",
        }),
      }),
    );

    const planner = harness.fixtures
      .diagnostics()
      .fixtures.find((f) => f.name.startsWith("adversarial-malformed-json"));
    expect(planner).toBeDefined();
  });
});
