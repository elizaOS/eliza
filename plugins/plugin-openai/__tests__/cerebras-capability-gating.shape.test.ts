/**
 * Shape test asserting that in Cerebras mode the media model types (image /
 * transcription / TTS) stay unregistered absent an explicit per-capability
 * endpoint override. Deterministic, mocked runtime.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import openaiPlugin from "../index";

const MEDIA_MODEL_TYPES = [
  ModelType.IMAGE_DESCRIPTION,
  ModelType.TRANSCRIPTION,
  ModelType.TEXT_TO_SPEECH,
  ModelType.IMAGE,
] as const;

const ENV_KEYS = [
  "ELIZA_PROVIDER",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "CEREBRAS_API_KEY",
  "CEREBRAS_BASE_URL",
  "OPENAI_IMAGE_DESCRIPTION_BASE_URL",
  "OPENAI_IMAGE_DESCRIPTION_API_KEY",
] as const;

const originalEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  originalEnv.clear();
  vi.restoreAllMocks();
});

function buildRuntime(settings: Record<string, string | undefined>): {
  runtime: IAgentRuntime;
  registeredModelTypes: () => string[];
  registeredModels: () => unknown[][];
} {
  const registerModel = vi.fn();
  const runtime = {
    getSetting: vi.fn((key: string) => (key in settings ? (settings[key] ?? null) : null)),
    registerModel,
  } as unknown as IAgentRuntime;
  return {
    runtime,
    registeredModelTypes: () => registerModel.mock.calls.map((call) => String(call[0])),
    registeredModels: () => registerModel.mock.calls,
  };
}

describe("plugin-openai media capability gating", () => {
  it("keeps the gated media capabilities out of the static models map", () => {
    for (const modelType of MEDIA_MODEL_TYPES) {
      expect(openaiPlugin.models?.[modelType]).toBeUndefined();
    }
    expect(openaiPlugin.models?.[ModelType.TEXT_SMALL]).toBeTypeOf("function");
  });

  it("registers no media capabilities in Cerebras mode (2026-06-10 incident config)", async () => {
    const { runtime, registeredModelTypes } = buildRuntime({
      OPENAI_BASE_URL: "https://api.cerebras.ai/v1",
      CEREBRAS_API_KEY: "csk-cerebras-fake",
    });

    await openaiPlugin.init?.({}, runtime);

    for (const modelType of MEDIA_MODEL_TYPES) {
      expect(registeredModelTypes()).not.toContain(modelType);
    }
  });

  it("performs no detached network probe during initialization", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("init must not fetch"));
    const { runtime } = buildRuntime({
      OPENAI_API_KEY: "sk-openai-fake",
    });

    await openaiPlugin.init?.({}, runtime);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("registers IMAGE_DESCRIPTION in Cerebras mode when an explicit vision base URL is set", async () => {
    const { runtime, registeredModelTypes } = buildRuntime({
      OPENAI_BASE_URL: "https://api.cerebras.ai/v1",
      CEREBRAS_API_KEY: "csk-cerebras-fake",
      OPENAI_IMAGE_DESCRIPTION_BASE_URL: "https://api.openai.com/v1",
      OPENAI_IMAGE_DESCRIPTION_API_KEY: "sk-vision-fake",
    });

    await openaiPlugin.init?.({}, runtime);

    expect(registeredModelTypes()).toContain(ModelType.IMAGE_DESCRIPTION);
    // The override is per-capability: the un-overridable endpoints stay gated.
    expect(registeredModelTypes()).not.toContain(ModelType.TRANSCRIPTION);
    expect(registeredModelTypes()).not.toContain(ModelType.TEXT_TO_SPEECH);
    expect(registeredModelTypes()).not.toContain(ModelType.IMAGE);
  });

  it("does not treat a vision API key alone as an override", async () => {
    // getImageDescriptionBaseURL falls back to getBaseURL when only the key is
    // set, so the capability would still POST to Cerebras and 400 per image.
    const { runtime, registeredModelTypes } = buildRuntime({
      ELIZA_PROVIDER: "cerebras",
      CEREBRAS_API_KEY: "csk-cerebras-fake",
      OPENAI_IMAGE_DESCRIPTION_API_KEY: "sk-vision-fake",
    });

    await openaiPlugin.init?.({}, runtime);

    expect(registeredModelTypes()).not.toContain(ModelType.IMAGE_DESCRIPTION);
  });

  it("registers all media capabilities in OpenAI mode", async () => {
    const { runtime, registeredModelTypes, registeredModels } = buildRuntime({
      OPENAI_API_KEY: "sk-openai-fake",
    });

    await openaiPlugin.init?.({}, runtime);

    expect(registeredModelTypes().sort()).toEqual([...MEDIA_MODEL_TYPES].sort());
    for (const registration of registeredModels()) {
      expect(registration[2]).toBe(openaiPlugin.name);
      expect(registration[3]).toBe(openaiPlugin.priority);
    }
  });
});
