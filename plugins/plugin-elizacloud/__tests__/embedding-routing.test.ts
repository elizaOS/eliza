import { ModelType } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { embeddingsPlugin } from "../../plugin-embeddings/src/index.ts";
import { elizaOSCloudPlugin, registerCloudEmbeddingModels } from "../src/index.ts";

type RegisteredModel = {
  modelType: string;
  provider: string;
  priority: number;
};

function createRuntime() {
  const registered: RegisteredModel[] = [];
  return {
    registered,
    getSetting(key: string) {
      return process.env[key];
    },
    registerModel(modelType: string, _handler: unknown, provider: string, priority = 0) {
      registered.push({ modelType, provider, priority });
      registered.sort((a, b) => b.priority - a.priority);
    },
  };
}

function registerByoEmbeddingModels(runtime: ReturnType<typeof createRuntime>) {
  for (const [modelType, handler] of Object.entries(embeddingsPlugin.models ?? {})) {
    runtime.registerModel(
      modelType,
      handler,
      embeddingsPlugin.name,
      embeddingsPlugin.priority ?? 0
    );
  }
}

function topProvider(runtime: ReturnType<typeof createRuntime>, modelType: string) {
  return runtime.registered.find((entry) => entry.modelType === modelType)?.provider;
}

const ENV_KEYS = [
  "ELIZAOS_CLOUD_USE_EMBEDDINGS",
  "EMBEDDING_BASE_URL",
  "EMBEDDING_API_KEY",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Eliza Cloud embedding routing", () => {
  it("does not register cloud embeddings when ELIZAOS_CLOUD_USE_EMBEDDINGS=false so BYO embeddings resolve", () => {
    process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS = "false";
    process.env.EMBEDDING_BASE_URL = "http://172.17.0.1:11434/v1";
    process.env.EMBEDDING_API_KEY = "ollama";

    const runtime = createRuntime();
    registerCloudEmbeddingModels(runtime as never);
    registerByoEmbeddingModels(runtime);

    expect(topProvider(runtime, ModelType.TEXT_EMBEDDING)).toBe(embeddingsPlugin.name);
    expect(topProvider(runtime, ModelType.TEXT_EMBEDDING_BATCH)).toBe(embeddingsPlugin.name);
    expect(runtime.registered.some((entry) => entry.provider === elizaOSCloudPlugin.name)).toBe(
      false
    );
  });

  it("keeps cloud embeddings as the priority winner when explicitly enabled", () => {
    process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS = "true";

    const runtime = createRuntime();
    registerCloudEmbeddingModels(runtime as never);
    registerByoEmbeddingModels(runtime);

    expect(topProvider(runtime, ModelType.TEXT_EMBEDDING)).toBe(elizaOSCloudPlugin.name);
    expect(topProvider(runtime, ModelType.TEXT_EMBEDDING_BATCH)).toBe(elizaOSCloudPlugin.name);
  });
});
