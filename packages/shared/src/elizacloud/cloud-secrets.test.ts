/** Exercises the real sealed secret lifecycle without leaking environment or module state. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearCloudSecrets,
  getCloudSecret,
  scrubCloudSecretsFromEnv,
} from "./cloud-secrets.ts";

const secrets = {
  ELIZAOS_CLOUD_API_KEY: "test-cloud-key",
  ELIZAOS_CLOUD_ENABLED: "true",
} as const;

beforeEach(() => {
  clearCloudSecrets();
  for (const key of Object.keys(secrets)) vi.stubEnv(key, undefined);
});
afterEach(() => {
  clearCloudSecrets();
  vi.unstubAllEnvs();
});

it("moves fallback credentials into sealed storage, preserves them on repeated scrub, and clears on disconnect", () => {
  for (const [key, value] of Object.entries(secrets)) vi.stubEnv(key, value);
  for (const key of Object.keys(secrets) as (keyof typeof secrets)[]) {
    expect(getCloudSecret(key)).toBe(secrets[key]);
  }
  scrubCloudSecretsFromEnv();
  scrubCloudSecretsFromEnv();
  for (const key of Object.keys(secrets) as (keyof typeof secrets)[]) {
    expect(process.env[key]).toBeUndefined();
    expect(getCloudSecret(key)).toBe(secrets[key]);
  }
  clearCloudSecrets();
  for (const key of Object.keys(secrets) as (keyof typeof secrets)[]) {
    expect(getCloudSecret(key)).toBeUndefined();
  }
});

it("leaves absent credentials absent", () => {
  scrubCloudSecretsFromEnv();
  expect(getCloudSecret("ELIZAOS_CLOUD_API_KEY")).toBeUndefined();
  expect(getCloudSecret("ELIZAOS_CLOUD_ENABLED")).toBeUndefined();
});
