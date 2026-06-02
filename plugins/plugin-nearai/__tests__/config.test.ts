import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  getApiKeyOptional,
  getBaseURL,
  getExperimentalTelemetry,
  getLargeModel,
  getRawSetting,
  getSmallModel,
  validateConfiguration,
} from "../utils/config";

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

  it("prefers non-empty runtime settings and falls back to environment values", () => {
    process.env.NEARAI_API_KEY = "env-key";
    process.env.NEARAI_BASE_URL = "https://env.example/v1";

    expect(getRawSetting(runtimeWith({ NEARAI_API_KEY: "runtime-key" }), "NEARAI_API_KEY")).toBe(
      "runtime-key"
    );
    expect(getRawSetting(runtimeWith({ NEARAI_API_KEY: "" }), "NEARAI_API_KEY")).toBe("env-key");
    expect(getBaseURL(runtimeWith({}))).toBe("https://env.example/v1");
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

  it("uses browser proxy base URL only when running in a browser-like environment", () => {
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const runtime = runtimeWith({
      NEARAI_BASE_URL: "https://server.example/v1",
      NEARAI_BROWSER_BASE_URL: "https://browser.example/proxy///",
    });

    try {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: {},
      });

      expect(getBaseURL(runtime)).toBe("https://browser.example/proxy");
    } finally {
      if (originalDocument) {
        Object.defineProperty(globalThis, "document", originalDocument);
      } else {
        Reflect.deleteProperty(globalThis, "document");
      }
    }

    expect(getBaseURL(runtime)).toBe("https://server.example/v1");
  });

  it("treats telemetry as enabled only for an explicit true setting", () => {
    expect(getExperimentalTelemetry(runtimeWith({ NEARAI_EXPERIMENTAL_TELEMETRY: "true" }))).toBe(
      true
    );
    expect(getExperimentalTelemetry(runtimeWith({ NEARAI_EXPERIMENTAL_TELEMETRY: "TRUE" }))).toBe(
      true
    );
    expect(getExperimentalTelemetry(runtimeWith({ NEARAI_EXPERIMENTAL_TELEMETRY: "1" }))).toBe(
      false
    );
  });

  it("fails fast for missing API keys in node environments", () => {
    expect(() => validateConfiguration(runtimeWith({}))).toThrow(/NEARAI_API_KEY is required/);
  });
});
