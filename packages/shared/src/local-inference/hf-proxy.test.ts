/**
 * Covers `resolveHfDownloadBase` / `resolveHfDownloadBases`, which decide where
 * local-inference bundle `resolve` traffic goes: explicit mirror overrides, the
 * Eliza Cloud HF proxy (when a cloud API key is set), then direct
 * huggingface.co. The harness saves/restores the relevant env vars and resets
 * the cloud-secrets cache around each case.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBootConfig, setBootConfig } from "../config/boot-config.js";
import { _resetCloudSecretsForTesting } from "../elizacloud/cloud-secrets.js";
import { resolveHfDownloadBase, resolveHfDownloadBases } from "./hf-proxy.js";

/**
 * `resolveHfDownloadBase` decides where local-inference bundle `resolve`
 * traffic goes. Precedence (highest first):
 *   1. `ELIZA_HF_BASE_URLS` / `ELIZA_HF_BASE_URL` mirrors.
 *   2. Eliza Cloud HF proxy — when `ELIZAOS_CLOUD_API_KEY` is present.
 *   3. Direct public huggingface.co — no auth.
 */
describe("resolveHfDownloadBase", () => {
  const savedConfig = getBootConfig();
  const savedEnv = {
    ACME_CLOUD_BASE_URL: process.env.ACME_CLOUD_BASE_URL,
    ELIZA_HF_BASE_URL: process.env.ELIZA_HF_BASE_URL,
    ELIZA_HF_BASE_URLS: process.env.ELIZA_HF_BASE_URLS,
    ELIZAOS_CLOUD_API_KEY: process.env.ELIZAOS_CLOUD_API_KEY,
    ELIZAOS_CLOUD_BASE_URL: process.env.ELIZAOS_CLOUD_BASE_URL,
  };

  beforeEach(() => {
    _resetCloudSecretsForTesting();
    delete process.env.ELIZA_HF_BASE_URL;
    delete process.env.ELIZA_HF_BASE_URLS;
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    delete process.env.ELIZAOS_CLOUD_BASE_URL;
    delete process.env.ACME_CLOUD_BASE_URL;
    setBootConfig(savedConfig);
  });

  afterEach(() => {
    _resetCloudSecretsForTesting();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setBootConfig(savedConfig);
  });

  it("routes directly to the public HuggingFace host when nothing is configured", () => {
    expect(resolveHfDownloadBase()).toEqual({
      base: "https://huggingface.co",
      viaCloud: false,
      label: "direct",
    });
  });

  it("routes through the Eliza Cloud HF proxy when a cloud API key is present", () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "key-123";
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api.elizacloud.ai";

    expect(resolveHfDownloadBase()).toEqual({
      base: "https://elizacloud.ai/api/v1/hf-proxy",
      authHeader: { authorization: "Bearer key-123" },
      viaCloud: true,
      label: "cloud",
    });
  });

  it("uses a branded cloud base URL alias for the cloud proxy without syncing env", () => {
    setBootConfig({
      ...savedConfig,
      envAliases: [["ACME_CLOUD_BASE_URL", "ELIZAOS_CLOUD_BASE_URL"]],
    });
    process.env.ELIZAOS_CLOUD_API_KEY = "key-123";
    process.env.ACME_CLOUD_BASE_URL = "https://acme.example.com/api/v1";

    expect(resolveHfDownloadBase()).toEqual({
      base: "https://acme.example.com/api/v1/hf-proxy",
      authHeader: { authorization: "Bearer key-123" },
      viaCloud: true,
      label: "cloud",
    });
    expect(process.env.ELIZAOS_CLOUD_BASE_URL).toBeUndefined();
  });

  it("tries explicit mirrors before the cloud proxy and public host", () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "key-123";
    process.env.ELIZA_HF_BASE_URLS =
      "https://hf-mirror-a.example.com/, https://hf-mirror-b.example.com";

    expect(resolveHfDownloadBases()).toEqual([
      {
        base: "https://hf-mirror-a.example.com",
        viaCloud: false,
        label: "mirror",
      },
      {
        base: "https://hf-mirror-b.example.com",
        viaCloud: false,
        label: "mirror",
      },
      {
        base: "https://elizacloud.ai/api/v1/hf-proxy",
        authHeader: { authorization: "Bearer key-123" },
        viaCloud: true,
        label: "cloud",
      },
      { base: "https://huggingface.co", viaCloud: false, label: "direct" },
    ]);
  });

  it("keeps the legacy single-base API on the first candidate", () => {
    process.env.ELIZA_HF_BASE_URL = "https://hf-mirror.example.com/sub/";

    expect(resolveHfDownloadBase()).toEqual({
      base: "https://hf-mirror.example.com/sub",
      viaCloud: false,
      label: "mirror",
    });
  });

  it("ignores a whitespace-only override and falls through to the next tier", () => {
    process.env.ELIZA_HF_BASE_URL = "   ";

    expect(resolveHfDownloadBase()).toEqual({
      base: "https://huggingface.co",
      viaCloud: false,
      label: "direct",
    });
  });
});
