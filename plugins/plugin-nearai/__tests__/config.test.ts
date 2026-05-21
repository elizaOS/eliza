import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { getApiKeyOptional, getBaseURL, getLargeModel, getSmallModel } from "../utils/config";

type Settings = Record<string, string | undefined>;

function runtimeWith(settings: Settings): IAgentRuntime {
  return {
    getSetting(key: string) {
      return settings[key];
    },
  } as unknown as IAgentRuntime;
}

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("NEAR AI config", () => {
  it("reads the canonical NEARAI_API_KEY setting", () => {
    const runtime = runtimeWith({ NEARAI_API_KEY: "canonical-key" });

    expect(getApiKeyOptional(runtime)).toBe("canonical-key");
  });

  it("uses NEAR AI endpoint and model defaults", () => {
    const runtime = runtimeWith({});

    expect(getBaseURL(runtime)).toBe("https://cloud-api.near.ai/v1");
    expect(getSmallModel(runtime)).toBe("Qwen/Qwen3.6-35B-A3B-FP8");
    expect(getLargeModel(runtime)).toBe("zai-org/GLM-5.1-FP8");
  });

  it("normalizes trailing slashes without appending /v1", () => {
    const runtime = runtimeWith({ NEARAI_BASE_URL: "https://cloud-api.near.ai/v1/" });

    expect(getBaseURL(runtime)).toBe("https://cloud-api.near.ai/v1");
  });
});
