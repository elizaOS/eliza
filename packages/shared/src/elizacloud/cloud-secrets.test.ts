/**
 * Coverage for the sealed cloud-secret store: env fallback, scrubbing from
 * process.env, clear-on-disconnect, and the test-only reset. Module state is
 * reset between tests via vi.resetModules + dynamic import.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CloudSecretsModule = {
  _resetCloudSecretsForTesting: () => void;
  clearCloudSecrets: () => void;
  getCloudSecret: typeof import("./cloud-secrets.ts").getCloudSecret;
  scrubCloudSecretsFromEnv: () => void;
};

const API_KEY = "ELIZAOS_CLOUD_API_KEY";
const ENABLED = "ELIZAOS_CLOUD_ENABLED";

async function loadSecrets(): Promise<CloudSecretsModule> {
  vi.resetModules();
  const mod = await import("./cloud-secrets.ts");
  mod._resetCloudSecretsForTesting();
  return mod;
}

beforeEach(() => {
  delete process.env[API_KEY];
  delete process.env[ENABLED];
});

afterEach(() => {
  delete process.env[API_KEY];
  delete process.env[ENABLED];
});

describe("getCloudSecret", () => {
  it("returns undefined when neither store nor env has the key", async () => {
    const mod = await loadSecrets();
    expect(mod.getCloudSecret(API_KEY)).toBeUndefined();
  });

  it("falls back to process.env when not sealed", async () => {
    process.env[API_KEY] = "sk-live-123";
    const mod = await loadSecrets();
    expect(mod.getCloudSecret(API_KEY)).toBe("sk-live-123");
  });
});

describe("scrubCloudSecretsFromEnv", () => {
  it("moves env values into the sealed store and deletes from env", async () => {
    process.env[API_KEY] = "sk-live-123";
    process.env[ENABLED] = "true";
    const mod = await loadSecrets();
    mod.scrubCloudSecretsFromEnv();
    expect(process.env[API_KEY]).toBeUndefined();
    expect(process.env[ENABLED]).toBeUndefined();
    expect(mod.getCloudSecret(API_KEY)).toBe("sk-live-123");
    expect(mod.getCloudSecret(ENABLED)).toBe("true");
  });

  it("is a no-op when the env keys are absent", async () => {
    const mod = await loadSecrets();
    mod.scrubCloudSecretsFromEnv();
    expect(mod.getCloudSecret(API_KEY)).toBeUndefined();
  });
});

describe("clearCloudSecrets", () => {
  it("removes sealed secrets after disconnect", async () => {
    process.env[API_KEY] = "sk-live-123";
    const mod = await loadSecrets();
    mod.scrubCloudSecretsFromEnv();
    expect(mod.getCloudSecret(API_KEY)).toBe("sk-live-123");
    mod.clearCloudSecrets();
    expect(mod.getCloudSecret(API_KEY)).toBeUndefined();
  });
});
