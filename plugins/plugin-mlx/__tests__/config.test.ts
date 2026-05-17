import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_MLX_URL,
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

describe("mlx config", () => {
  it("defaults base URL to mlx_lm.server's localhost endpoint", () => {
    expect(getBaseURL(makeRuntime())).toBe(DEFAULT_MLX_URL);
  });

  it("appends /v1 when the configured URL omits it", () => {
    expect(getBaseURL(makeRuntime({ MLX_BASE_URL: "http://localhost:8080" }))).toBe(
      "http://localhost:8080/v1"
    );
  });

  it("keeps explicit /v1 suffix", () => {
    expect(getBaseURL(makeRuntime({ MLX_BASE_URL: "http://10.0.0.5:9999/v1" }))).toBe(
      "http://10.0.0.5:9999/v1"
    );
  });

  it("strips trailing slashes before appending /v1", () => {
    expect(getBaseURL(makeRuntime({ MLX_BASE_URL: "http://host:8080///" }))).toBe(
      "http://host:8080/v1"
    );
  });

  it("derives api base by stripping /v1", () => {
    expect(getApiBase(makeRuntime({ MLX_BASE_URL: "http://host:8080/v1" }))).toBe(
      "http://host:8080"
    );
  });

  it("returns undefined for unset api key", () => {
    expect(getApiKey(makeRuntime())).toBeUndefined();
  });

  it("returns api key when set, trimmed", () => {
    expect(getApiKey(makeRuntime({ MLX_API_KEY: "  secret-key  " }))).toBe("secret-key");
  });

  it("falls back to SMALL_MODEL when MLX_SMALL_MODEL not set", () => {
    expect(
      getSmallModel(makeRuntime({ SMALL_MODEL: "mlx-community/Llama-3.2-3B-Instruct-4bit" }))
    ).toBe("mlx-community/Llama-3.2-3B-Instruct-4bit");
  });

  it("prefers MLX_SMALL_MODEL over generic SMALL_MODEL", () => {
    expect(
      getSmallModel(
        makeRuntime({
          MLX_SMALL_MODEL: "mlx-small",
          SMALL_MODEL: "generic-small",
        })
      )
    ).toBe("mlx-small");
  });

  it("reads MLX_LARGE_MODEL", () => {
    expect(getLargeModel(makeRuntime({ MLX_LARGE_MODEL: "mlx-large" }))).toBe("mlx-large");
  });

  it("reads MLX_EMBEDDING_MODEL", () => {
    expect(getEmbeddingModel(makeRuntime({ MLX_EMBEDDING_MODEL: "mlx-embed" }))).toBe("mlx-embed");
  });

  it("auto-detect defaults to true when unset", () => {
    expect(shouldAutoDetect(makeRuntime())).toBe(true);
  });

  it("auto-detect respects truthy values", () => {
    expect(shouldAutoDetect(makeRuntime({ MLX_AUTO_DETECT: "1" }))).toBe(true);
    expect(shouldAutoDetect(makeRuntime({ MLX_AUTO_DETECT: "yes" }))).toBe(true);
    expect(shouldAutoDetect(makeRuntime({ MLX_AUTO_DETECT: "on" }))).toBe(true);
  });

  it("auto-detect respects falsy values", () => {
    expect(shouldAutoDetect(makeRuntime({ MLX_AUTO_DETECT: "0" }))).toBe(false);
    expect(shouldAutoDetect(makeRuntime({ MLX_AUTO_DETECT: "false" }))).toBe(false);
    expect(shouldAutoDetect(makeRuntime({ MLX_AUTO_DETECT: "off" }))).toBe(false);
  });

  it("respects process.env as fallback", () => {
    process.env.MLX_BASE_URL = "http://env-host:5555";
    expect(getBaseURL(makeRuntime())).toBe("http://env-host:5555/v1");
  });
});
