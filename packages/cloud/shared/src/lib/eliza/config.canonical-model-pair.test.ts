// Exercises the canonical-pair leg of getDefaultModels with deterministic env fixtures.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CEREBRAS_DEFAULT_TEXT_LARGE_MODEL, CEREBRAS_DEFAULT_TEXT_SMALL_MODEL } from "../models";
import {
  buildElevenLabsSettings,
  getDefaultModels,
  getElizaCloudApiUrl,
  isAllowedChatModel,
} from "./config";

/**
 * `getDefaultModels` is the cloud-lane read of the canonical two-knob pair
 * (ELIZA_MODEL_SMALL/LARGE): the pair sits below the ELIZAOS_CLOUD_* escape
 * hatches and above the Cerebras defaults, blank values are unset, and the
 * embedding model never derives from the pair (dimension pinning).
 *
 * The pair leg is FAMILY-GATED as the "elizacloud" family (the PR's isolation
 * invariant): a foreign-family qualified value must never become this lane's
 * literal model id, and a matching elizacloud/… qualification is stripped.
 */
const ENV_KEYS = [
  "ELIZAOS_CLOUD_SMALL_MODEL",
  "ELIZAOS_CLOUD_LARGE_MODEL",
  "ELIZAOS_CLOUD_EMBEDDING_MODEL",
  "ELIZA_MODEL_SMALL",
  "ELIZA_MODEL_LARGE",
  "ELIZAOS_CLOUD_BASE_URL",
  "NEXT_PUBLIC_APP_URL",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("getDefaultModels canonical pair", () => {
  it("falls back to the Cerebras defaults when nothing is set", () => {
    expect(getDefaultModels()).toEqual({
      small: CEREBRAS_DEFAULT_TEXT_SMALL_MODEL,
      large: CEREBRAS_DEFAULT_TEXT_LARGE_MODEL,
      embedding: "text-embedding-3-small",
    });
  });

  it("derives small/large from the trimmed pair when the cloud keys are unset", () => {
    process.env.ELIZA_MODEL_SMALL = " canonical-small ";
    process.env.ELIZA_MODEL_LARGE = "canonical-large";
    const models = getDefaultModels();
    expect(models.small).toBe("canonical-small");
    expect(models.large).toBe("canonical-large");
  });

  it("keeps ELIZAOS_CLOUD_* as the winning escape hatch", () => {
    process.env.ELIZAOS_CLOUD_SMALL_MODEL = "explicit-small";
    process.env.ELIZA_MODEL_SMALL = "canonical-small";
    expect(getDefaultModels().small).toBe("explicit-small");
  });

  it("rejects foreign-family qualified pair values (family isolation)", () => {
    // The exact poisoning case from review: an anthropic-qualified id must not
    // become the cloud lane's literal model string.
    process.env.ELIZA_MODEL_LARGE = "anthropic/claude-opus-4-8";
    expect(getDefaultModels().large).toBe(CEREBRAS_DEFAULT_TEXT_LARGE_MODEL);
    process.env.ELIZA_MODEL_SMALL = "openai/gpt-5.5";
    expect(getDefaultModels().small).toBe(CEREBRAS_DEFAULT_TEXT_SMALL_MODEL);
  });

  it("strips a matching elizacloud-family qualification to the bare id", () => {
    process.env.ELIZA_MODEL_LARGE = "elizacloud/zai-glm-4.7";
    expect(getDefaultModels().large).toBe("zai-glm-4.7");
    process.env.ELIZA_MODEL_SMALL = "cloud/gemma-4-31b";
    expect(getDefaultModels().small).toBe("gemma-4-31b");
  });

  it("passes unknown-prefix slash values through as whole model ids", () => {
    process.env.ELIZA_MODEL_LARGE = "meta-llama/llama-4-maverick";
    expect(getDefaultModels().large).toBe("meta-llama/llama-4-maverick");
  });

  it("treats a blank pair value as unset", () => {
    process.env.ELIZA_MODEL_LARGE = "   ";
    expect(getDefaultModels().large).toBe(CEREBRAS_DEFAULT_TEXT_LARGE_MODEL);
  });

  it("never derives the embedding model from the pair", () => {
    process.env.ELIZA_MODEL_SMALL = "canonical-small";
    expect(getDefaultModels().embedding).toBe("text-embedding-3-small");
  });
});

describe("getElizaCloudApiUrl", () => {
  const savedNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
  });

  it("honors the explicit ELIZAOS_CLOUD_BASE_URL override", () => {
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://override.example/api/v1";
    expect(getElizaCloudApiUrl()).toBe("https://override.example/api/v1");
  });

  it("uses localhost in test/development environments", () => {
    process.env.NODE_ENV = "test";
    expect(getElizaCloudApiUrl()).toBe("http://localhost:3000/api/v1");
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:4000";
    expect(getElizaCloudApiUrl()).toBe("http://localhost:4000/api/v1");
  });

  it("maps the dev app URL to the dev API and defaults to production", () => {
    process.env.NODE_ENV = "production";
    process.env.NEXT_PUBLIC_APP_URL = "https://dev.elizacloud.ai";
    expect(getElizaCloudApiUrl()).toBe("https://dev.elizacloud.ai/api/v1");
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(getElizaCloudApiUrl()).toBe("https://elizacloud.ai/api/v1");
  });
});

describe("isAllowedChatModel", () => {
  it("accepts curated ids and rejects unknown ones", () => {
    expect(isAllowedChatModel("anthropic/claude-sonnet-4.6")).toBe(true);
    expect(isAllowedChatModel("not-a-provider/not-a-model")).toBe(false);
  });
});

describe("buildElevenLabsSettings", () => {
  const ELEVEN_KEYS = ["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "ELEVENLABS_STT_NUM_SPEAKERS"];
  const savedEleven: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of ELEVEN_KEYS) {
      savedEleven[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of ELEVEN_KEYS) {
      if (savedEleven[key] === undefined) delete process.env[key];
      else process.env[key] = savedEleven[key];
    }
  });

  it("prefers character settings, then env, then defaults", () => {
    process.env.ELEVENLABS_API_KEY = "env-key";
    const settings = buildElevenLabsSettings({ ELEVENLABS_VOICE_ID: "char-voice" });
    expect(settings.ELEVENLABS_API_KEY).toBe("env-key");
    expect(settings.ELEVENLABS_VOICE_ID).toBe("char-voice");
    expect(settings.ELEVENLABS_MODEL_ID).toBe("eleven_multilingual_v2");
    expect(settings.ELEVENLABS_STT_NUM_SPEAKERS).toBeUndefined();
  });

  it("carries the optional speaker count through when provided", () => {
    const settings = buildElevenLabsSettings({ ELEVENLABS_STT_NUM_SPEAKERS: 2 });
    expect(settings.ELEVENLABS_STT_NUM_SPEAKERS).toBe("2");
  });
});
