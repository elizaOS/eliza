/**
 * Exercises the credential resolver (`resolveProviderCredential`,
 * `resolveProviderCredentialMulti`, `scanAllCredentials`) against the real
 * core model-provider secret catalog and `SECRET_KEY_ALIASES`, driving actual
 * `process.env` values (no mocks) and restoring them per test. Covers env-alias
 * normalization, full-catalog scanning, and refusal of subscription selections.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveProviderCredential,
  resolveProviderCredentialMulti,
  scanAllCredentials,
} from "./credential-resolver.js";

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "Z_AI_API_KEY",
  "MOONSHOT_API_KEY",
  "KIMI_API_KEY",
  "CEREBRAS_API_KEY",
  "NEAR_AI_API_KEY",
] as const;

const previousEnv = new Map<string, string | undefined>();

for (const key of ENV_KEYS) {
  previousEnv.set(key, process.env[key]);
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const previous = previousEnv.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

describe("credential resolver registry-derived sources", () => {
  it("resolves first-run provider ids through core model-provider secrets", () => {
    process.env.CEREBRAS_API_KEY = "csk-test";

    expect(resolveProviderCredential("cerebras")).toEqual({
      providerId: "cerebras",
      envVar: "CEREBRAS_API_KEY",
      apiKey: "csk-test",
      authType: "api-key",
    });
  });

  it("resolves env aliases from core SECRET_KEY_ALIASES", () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "google-alias";
    process.env.Z_AI_API_KEY = "zai-alias";
    process.env.KIMI_API_KEY = "kimi-alias";

    expect(resolveProviderCredential("gemini")).toMatchObject({
      providerId: "gemini",
      envVar: "GOOGLE_GENERATIVE_AI_API_KEY",
      apiKey: "google-alias",
    });
    expect(resolveProviderCredential("z.ai")).toMatchObject({
      providerId: "zai",
      envVar: "Z_AI_API_KEY",
      apiKey: "zai-alias",
    });
    expect(resolveProviderCredential("kimi")).toMatchObject({
      providerId: "moonshot",
      envVar: "KIMI_API_KEY",
      apiKey: "kimi-alias",
    });
  });

  it("scans credentials from the canonical model-provider catalog", () => {
    process.env.NEAR_AI_API_KEY = "nearai-alias";
    process.env.CEREBRAS_API_KEY = "csk-test";

    expect(scanAllCredentials()).toEqual(
      expect.arrayContaining([
        {
          providerId: "nearai",
          envVar: "NEAR_AI_API_KEY",
          apiKey: "nearai-alias",
          authType: "api-key",
        },
        {
          providerId: "cerebras",
          envVar: "CEREBRAS_API_KEY",
          apiKey: "csk-test",
          authType: "api-key",
        },
      ]),
    );
  });

  it("uses first-run/direct-account metadata for multi-account request aliases", async () => {
    process.env.CEREBRAS_API_KEY = "csk-env-fallback";

    await expect(resolveProviderCredentialMulti("cerebras")).resolves.toEqual({
      providerId: "cerebras",
      envVar: "CEREBRAS_API_KEY",
      apiKey: "csk-env-fallback",
      authType: "api-key",
    });
  });

  it("refuses subscription selections through the shared subscription provider metadata", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-direct";

    await expect(
      resolveProviderCredentialMulti("openai-subscription"),
    ).resolves.toBeNull();
  });
});
