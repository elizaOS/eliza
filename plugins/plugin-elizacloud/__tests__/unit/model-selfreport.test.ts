/**
 * Cloud-brained model self-report: drives the REAL registerTextInferenceModels
 * into an AgentRuntime-shaped model registry, then runs core's REAL
 * RUNTIME_MODEL_CONTEXT provider against it — the integration seam that decides
 * whether "what model are you?" can name the concrete cloud model. Deterministic
 * (no live model); process env for every model-tier key is isolated per test.
 */

import type { IAgentRuntime, Memory, ModelRegistrationMetadata } from "@elizaos/core";
import {
  DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
  ModelType,
  runtimeModelContextProvider,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerTextInferenceModels } from "../../src/index";
import { DEFAULT_ELIZA_CLOUD_LARGE_MODEL } from "../../src/utils/config";

// Every env key either the plugin's tier getters (resolveSetting → process.env)
// or the provider's slot fallback (readSetting → readEnv) consults. Cleared per
// test so a host-written model var can't mask the resolution under test.
const MODEL_ENV_KEYS = (() => {
  const suffixes = [
    "NANO_MODEL",
    "SMALL_MODEL",
    "MEDIUM_MODEL",
    "LARGE_MODEL",
    "MEGA_MODEL",
    "RESPONSE_HANDLER_MODEL",
    "SHOULD_RESPOND_MODEL",
    "ACTION_PLANNER_MODEL",
    "PLANNER_MODEL",
    "RESPONSE_MODEL",
    "REASONING_SMALL_MODEL",
    "REASONING_LARGE_MODEL",
    "COMPLETION_MODEL",
  ];
  const keys: string[] = ["ELIZAOS_CLOUD_USE_INFERENCE"];
  for (const prefix of ["", "OLLAMA_", "OPENAI_", "ANTHROPIC_", "ELIZAOS_CLOUD_"]) {
    for (const suffix of suffixes) keys.push(`${prefix}${suffix}`);
  }
  return keys;
})();

let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = {};
  for (const key of MODEL_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of MODEL_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

interface RegisteredModel {
  handler: unknown;
  metadata?: ModelRegistrationMetadata;
  provider: string;
  priority: number;
  registrationOrder: number;
}

// Mirrors AgentRuntime's registerModel storage (push + priority-desc sort into
// the `models` map) so the provider's registry reads exercise the same shape a
// live cloud-brained agent exposes.
function makeCloudBrainedRuntime(settings: Record<string, string>) {
  const models = new Map<string, RegisteredModel[]>();
  const runtime = {
    getSetting: (key: string) => settings[key] ?? null,
    models,
    registerModel: (
      modelType: string,
      handler: unknown,
      provider: string,
      priority?: number,
      metadata?: ModelRegistrationMetadata
    ) => {
      const list = models.get(modelType) ?? [];
      list.push({
        handler,
        metadata,
        provider,
        priority: priority || 0,
        registrationOrder: list.length,
      });
      list.sort((a, b) => (b.priority || 0) - (a.priority || 0));
      models.set(modelType, list);
    },
  } as unknown as IAgentRuntime;
  return runtime;
}

function selfModelQuestion(): Memory {
  return { content: { text: "what model are you?", source: "test" } } as Memory;
}

describe("cloud-brained model self-report", () => {
  it("reports the concrete default cloud model when no tier is configured", async () => {
    // The default cloud deployment: an API key and nothing else — every tier
    // resolves inside the plugin's getters to a code default the runtime's
    // *_MODEL env fallbacks cannot see.
    const runtime = makeCloudBrainedRuntime({
      ELIZAOS_CLOUD_API_KEY: "eliza_test_key",
    });
    registerTextInferenceModels(runtime);

    const result = await runtimeModelContextProvider.get(runtime, selfModelQuestion(), {} as never);

    expect(result.text).toContain(`Response handler model: ${DEFAULT_ELIZA_CLOUD_TEXT_MODEL}`);
    expect(result.text).toContain(`Large text model: ${DEFAULT_ELIZA_CLOUD_LARGE_MODEL}`);
    expect(result.text).toContain("Response handler provider adapter: elizaOSCloud");
    // The provider's omit-rather-than-leak contract still holds.
    expect(result.text).not.toContain("RESPONSE_HANDLER");
    expect(result.text).not.toContain("TEXT_LARGE");
    expect(result.data?.responseHandlerModel).toBe(DEFAULT_ELIZA_CLOUD_TEXT_MODEL);
    expect(result.data?.textLargeModel).toBe(DEFAULT_ELIZA_CLOUD_LARGE_MODEL);
  });

  it("reports ELIZAOS_CLOUD_* configured tiers the runtime env fallbacks cannot see", async () => {
    const runtime = makeCloudBrainedRuntime({
      ELIZAOS_CLOUD_API_KEY: "eliza_test_key",
      ELIZAOS_CLOUD_SMALL_MODEL: "gpt-oss-120b",
      ELIZAOS_CLOUD_LARGE_MODEL: "zai-glm-4.7",
    });
    registerTextInferenceModels(runtime);

    const result = await runtimeModelContextProvider.get(runtime, selfModelQuestion(), {} as never);

    // Response handler falls back to the small tier, planner to the large tier
    // — the same chains the handlers resolve per call.
    expect(result.text).toContain("Response handler model: gpt-oss-120b");
    expect(result.text).toContain("Action planner model: zai-glm-4.7");
    expect(result.text).toContain("Large text model: zai-glm-4.7");
    expect(result.text).toContain("Small text model: gpt-oss-120b");
  });

  it("registers every chat-brain slot with its resolved concrete display model", () => {
    const runtime = makeCloudBrainedRuntime({
      ELIZAOS_CLOUD_API_KEY: "eliza_test_key",
      ELIZAOS_CLOUD_LARGE_MODEL: "zai-glm-4.7",
    });
    registerTextInferenceModels(runtime);

    const models = (runtime as unknown as { models: Map<string, RegisteredModel[]> }).models;
    const displayFor = (slot: string) => models.get(slot)?.[0]?.metadata?.displayModel;

    expect(displayFor(String(ModelType.TEXT_LARGE))).toBe("zai-glm-4.7");
    expect(displayFor(String(ModelType.TEXT_MEGA ?? "TEXT_MEGA"))).toBe("zai-glm-4.7");
    expect(displayFor(String(ModelType.ACTION_PLANNER ?? "ACTION_PLANNER"))).toBe("zai-glm-4.7");
    for (const slot of [
      String(ModelType.TEXT_NANO ?? "TEXT_NANO"),
      String(ModelType.TEXT_SMALL),
      String(ModelType.TEXT_MEDIUM ?? "TEXT_MEDIUM"),
      String(ModelType.RESPONSE_HANDLER ?? "RESPONSE_HANDLER"),
    ]) {
      expect(displayFor(slot)).toBe(DEFAULT_ELIZA_CLOUD_TEXT_MODEL);
    }
  });
});
