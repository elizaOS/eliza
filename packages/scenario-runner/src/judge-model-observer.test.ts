/**
 * Exercises model identity capture through a real runtime registry and event
 * bus with deterministic model handlers, including asynchronous isolation.
 */
import {
  AgentRuntime,
  createCharacter,
  EventType,
  ModelType,
} from "@elizaos/core";
import { InMemoryDatabaseAdapter } from "@elizaos/testing/in-memory-adapter";
import { describe, expect, it, vi } from "vitest";
import { isJudgeIndependent } from "./judge-independence.ts";
import {
  compareJudgeModels,
  JudgeModelObserver,
} from "./judge-model-observer.ts";

function runtimeFixture(emit = true) {
  const runtime = new AgentRuntime({
    character: createCharacter({ name: "Identity observer" }),
    adapter: new InMemoryDatabaseAdapter(),
    enableAutonomy: false,
    logLevel: "fatal",
  });
  runtime.registerModel(
    ModelType.TEXT_LARGE,
    async (rt, params) => {
      await Promise.resolve();
      if (emit)
        await rt.emitEvent(EventType.MODEL_USED, {
          runtime: rt,
          source: "test",
          type: ModelType.TEXT_LARGE,
          provider: "cerebras",
          model: params.prompt === "judge" ? "gemma-4-31b" : "qwen-3.8-27b",
        });
      return "complete result";
    },
    "test",
  );
  return runtime;
}
describe("judge model identity observations", () => {
  it("separates concurrent judge and actor events and restores the runtime", async () => {
    const runtime = runtimeFixture();
    const original = runtime.useModel;
    const before = runtime.getEvent(EventType.MODEL_USED)?.length ?? 0;
    const observer = new JudgeModelObserver(runtime);
    try {
      const [judged, actor] = await Promise.all([
        observer.judge(() =>
          runtime.useModel(ModelType.TEXT_LARGE, { prompt: "judge" }),
        ),
        runtime.useModel(ModelType.TEXT_LARGE, { prompt: "actor" }),
      ]);
      expect(actor).toBe("complete result");
      expect(judged.value).toBe("complete result");
      expect(observer.actorModels().map((row) => row.model)).toEqual([
        "qwen-3.8-27b",
      ]);
      expect(judged.models.map((row) => row.model)).toEqual(["gemma-4-31b"]);
      expect(compareJudgeModels(observer.actorModels(), judged.models)).toBe(
        "unknown",
      );
    } finally {
      observer.close();
    }
    expect(runtime.useModel).toBe(original);
    expect(runtime.getEvent(EventType.MODEL_USED)?.length ?? 0).toBe(before);
    await runtime.close();
  });
  it("does not certify a runtime call that emitted no serving identity", async () => {
    const runtime = runtimeFixture(false);
    const observer = new JudgeModelObserver(runtime);
    try {
      await runtime.useModel(ModelType.TEXT_LARGE, { prompt: "actor" });
      const judged = await observer.judge(() =>
        runtime.useModel(ModelType.TEXT_LARGE, { prompt: "judge" }),
      );
      expect(compareJudgeModels(observer.actorModels(), judged.models)).toBe(
        "unknown",
      );
      expect(observer.actorModels()[0].source).toBe("unavailable");
    } finally {
      observer.close();
      await runtime.close();
    }
  });
  it("requires response identity before distinct labels establish independence", () => {
    const actor = {
      provider: "cerebras",
      model: "qwen-3.8-27b",
      source: "provider-response" as const,
    };
    const judge = { ...actor, model: "gemma-4-31b" };
    expect(compareJudgeModels([actor], [judge])).toBe("independent");
    expect(
      compareJudgeModels([{ ...actor, source: "runtime-event" }], [judge]),
    ).toBe("unknown");
  });
  it("does not treat dedicated credentials as identity evidence", async () => {
    vi.stubEnv("CEREBRAS_API_KEY", "fixture-key");
    try {
      expect(await isJudgeIndependent()).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("recognizes the same model through a qualified alias and different provider", () => {
    expect(
      compareJudgeModels(
        [
          {
            provider: "openrouter",
            model: "qwen/qwen-3.8-27b",
            source: "runtime-event",
          },
        ],
        [
          {
            provider: "cerebras",
            model: "qwen-3.8-27b",
            source: "provider-response",
          },
        ],
      ),
    ).toBe("self-graded");
  });
  it("does not certify an unknown gateway backend or absent actor observations", () => {
    const model = {
      provider: "cerebras",
      model: "gemma-4-31b",
      source: "provider-response" as const,
    };
    expect(compareJudgeModels([], [model])).toBe("unknown");
    expect(compareJudgeModels([{ ...model, provider: null }], [model])).toBe(
      "unknown",
    );
  });
});
