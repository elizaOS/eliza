import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_LMSTUDIO_URL,
  getApiBase,
  getApiKey,
  getBaseURL,
  getEmbeddingModel,
  getLargeModel,
  getSmallModel,
  shouldAutoDetect,
} from "../utils/config";

type Setting = string | number | boolean | null;
function makeRuntime(settings: Record<string, Setting> = {}): {
  getSetting: (key: string) => Setting;
} {
  return {
    getSetting: (key: string) => (key in settings ? settings[key]! : null),
  };
}

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("lmstudio config", () => {
  it("defaults base URL to LM Studio's localhost endpoint", () => {
    expect(getBaseURL(makeRuntime())).toBe(DEFAULT_LMSTUDIO_URL);
  });

  it("appends /v1 when the configured URL omits it", () => {
    expect(getBaseURL(makeRuntime({ LMSTUDIO_BASE_URL: "http://localhost:1234" }))).toBe(
      "http://localhost:1234/v1"
    );
  });

  it("keeps explicit /v1 suffix", () => {
    expect(getBaseURL(makeRuntime({ LMSTUDIO_BASE_URL: "http://10.0.0.5:9999/v1" }))).toBe(
      "http://10.0.0.5:9999/v1"
    );
  });

  it("strips trailing slashes before appending /v1", () => {
    expect(getBaseURL(makeRuntime({ LMSTUDIO_BASE_URL: "http://host:1234///" }))).toBe(
      "http://host:1234/v1"
    );
  });

  it("derives api base by stripping /v1", () => {
    expect(getApiBase(makeRuntime({ LMSTUDIO_BASE_URL: "http://host:1234/v1" }))).toBe(
      "http://host:1234"
    );
  });

  it("returns undefined for unset api key", () => {
    expect(getApiKey(makeRuntime())).toBeUndefined();
  });

  it("returns api key when set, trimmed", () => {
    expect(getApiKey(makeRuntime({ LMSTUDIO_API_KEY: "  secret-key  " }))).toBe("secret-key");
  });

  it("falls back to SMALL_MODEL when LMSTUDIO_SMALL_MODEL not set", () => {
    expect(getSmallModel(makeRuntime({ SMALL_MODEL: "qwen-2.5-3b" }))).toBe("qwen-2.5-3b");
  });

  it("prefers LMSTUDIO_SMALL_MODEL over generic SMALL_MODEL", () => {
    expect(
      getSmallModel(
        makeRuntime({ LMSTUDIO_SMALL_MODEL: "lms-small", SMALL_MODEL: "generic-small" })
      )
    ).toBe("lms-small");
  });

  it("reads LMSTUDIO_LARGE_MODEL", () => {
    expect(getLargeModel(makeRuntime({ LMSTUDIO_LARGE_MODEL: "lms-large" }))).toBe("lms-large");
  });

  it("reads LMSTUDIO_EMBEDDING_MODEL", () => {
    expect(getEmbeddingModel(makeRuntime({ LMSTUDIO_EMBEDDING_MODEL: "nomic-embed" }))).toBe(
      "nomic-embed"
    );
  });

  it("auto-detect defaults to true when unset", () => {
    expect(shouldAutoDetect(makeRuntime())).toBe(true);
  });

  it("auto-detect respects truthy values", () => {
    expect(shouldAutoDetect(makeRuntime({ LMSTUDIO_AUTO_DETECT: "1" }))).toBe(true);
    expect(shouldAutoDetect(makeRuntime({ LMSTUDIO_AUTO_DETECT: "yes" }))).toBe(true);
    expect(shouldAutoDetect(makeRuntime({ LMSTUDIO_AUTO_DETECT: "on" }))).toBe(true);
  });

  it("auto-detect respects falsy values", () => {
    expect(shouldAutoDetect(makeRuntime({ LMSTUDIO_AUTO_DETECT: "0" }))).toBe(false);
    expect(shouldAutoDetect(makeRuntime({ LMSTUDIO_AUTO_DETECT: "false" }))).toBe(false);
    expect(shouldAutoDetect(makeRuntime({ LMSTUDIO_AUTO_DETECT: "off" }))).toBe(false);
  });

  it("respects process.env as fallback", () => {
    process.env.LMSTUDIO_BASE_URL = "http://env-host:5555";
    expect(getBaseURL(makeRuntime())).toBe("http://env-host:5555/v1");
  });
});
