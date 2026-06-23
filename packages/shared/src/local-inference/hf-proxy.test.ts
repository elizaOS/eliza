import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetCloudSecretsForTesting } from "../elizacloud/cloud-secrets.js";
import { resolveHfDownloadBase } from "./hf-proxy.js";

/**
 * `resolveHfDownloadBase` decides where local-inference bundle `resolve`
 * traffic goes. Precedence (highest first):
 *   1. `ELIZA_HF_BASE_URL` override — always wins, no auth.
 *   2. Eliza Cloud HF proxy — when `ELIZAOS_CLOUD_API_KEY` is present.
 *   3. Direct public huggingface.co — no auth.
 */
describe("resolveHfDownloadBase", () => {
  const savedEnv = {
    ELIZA_HF_BASE_URL: process.env.ELIZA_HF_BASE_URL,
    ELIZAOS_CLOUD_API_KEY: process.env.ELIZAOS_CLOUD_API_KEY,
    ELIZAOS_CLOUD_BASE_URL: process.env.ELIZAOS_CLOUD_BASE_URL,
  };

  beforeEach(() => {
    _resetCloudSecretsForTesting();
    delete process.env.ELIZA_HF_BASE_URL;
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    delete process.env.ELIZAOS_CLOUD_BASE_URL;
  });

  afterEach(() => {
    _resetCloudSecretsForTesting();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("routes directly to the public HuggingFace host when nothing is configured", () => {
    expect(resolveHfDownloadBase()).toEqual({
      base: "https://huggingface.co",
      viaCloud: false,
    });
  });

  it("routes through the Eliza Cloud HF proxy when a cloud API key is present", () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "key-123";
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api.elizacloud.ai";

    expect(resolveHfDownloadBase()).toEqual({
      base: "https://www.elizacloud.ai/api/v1/hf-proxy",
      authHeader: { authorization: "Bearer key-123" },
      viaCloud: true,
    });
  });

  it("prefers the explicit ELIZA_HF_BASE_URL override over the cloud proxy", () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "key-123";
    process.env.ELIZA_HF_BASE_URL = "https://hf-mirror.example.com/";

    // Override wins, trailing slash trimmed, no auth header, not via cloud.
    expect(resolveHfDownloadBase()).toEqual({
      base: "https://hf-mirror.example.com",
      viaCloud: false,
    });
  });

  it("trims a trailing slash from the override base", () => {
    process.env.ELIZA_HF_BASE_URL = "https://hf-mirror.example.com/sub/";

    expect(resolveHfDownloadBase().base).toBe(
      "https://hf-mirror.example.com/sub",
    );
  });

  it("ignores a whitespace-only override and falls through to the next tier", () => {
    process.env.ELIZA_HF_BASE_URL = "   ";

    expect(resolveHfDownloadBase()).toEqual({
      base: "https://huggingface.co",
      viaCloud: false,
    });
  });
});
