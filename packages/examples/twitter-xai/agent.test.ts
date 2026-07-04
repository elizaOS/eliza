/**
 * Deterministic coverage for X/Grok example environment validation and runtime
 * settings propagation.
 */
import { afterEach, expect, test } from "bun:test";
import { AgentRuntime, getBasicCapabilitiesSettings } from "@elizaos/core";
import { requireEnv, validateEnvironment } from "./agent";
import { character } from "./character";

const ENV_KEYS = [
  "XAI_API_KEY",
  "TWITTER_AUTH_MODE",
  "TWITTER_BROKER_TOKEN",
  "ELIZAOS_CLOUD_API_KEY",
  "TWITTER_CLIENT_ID",
  "TWITTER_REDIRECT_URI",
  "TWITTER_API_KEY",
  "TWITTER_API_SECRET_KEY",
  "TWITTER_ACCESS_TOKEN",
  "TWITTER_ACCESS_TOKEN_SECRET",
  "POSTGRES_URL",
];

const originalEnv = Object.fromEntries(
  ENV_KEYS.map((envKey) => [envKey, process.env[envKey]]),
);

function resetExampleEnv(): void {
  for (const envKey of ENV_KEYS) {
    delete process.env[envKey];
  }
}

afterEach(() => {
  resetExampleEnv();
  for (const [envKey, value] of Object.entries(originalEnv)) {
    if (value !== undefined) {
      process.env[envKey] = value;
    }
  }
});

test("requireEnv trims present values and rejects missing values", () => {
  process.env.XAI_API_KEY = "  xai-test-key  ";
  expect(requireEnv("XAI_API_KEY")).toBe("  xai-test-key  ");

  process.env.XAI_API_KEY = " ";
  expect(() => requireEnv("XAI_API_KEY")).toThrow(
    "Missing required environment variable: XAI_API_KEY",
  );
});

test("validateEnvironment accepts broker auth with either broker credential", () => {
  resetExampleEnv();
  process.env.XAI_API_KEY = "xai-test-key";
  process.env.TWITTER_AUTH_MODE = "broker";
  process.env.TWITTER_BROKER_TOKEN = "broker-test-token";
  expect(() => validateEnvironment()).not.toThrow();

  delete process.env.TWITTER_BROKER_TOKEN;
  process.env.ELIZAOS_CLOUD_API_KEY = "cloud-test-key";
  expect(() => validateEnvironment()).not.toThrow();
});

test("validateEnvironment enforces oauth and env auth requirements", () => {
  resetExampleEnv();
  process.env.XAI_API_KEY = "xai-test-key";
  process.env.TWITTER_AUTH_MODE = "oauth";
  expect(() => validateEnvironment()).toThrow("TWITTER_CLIENT_ID");

  process.env.TWITTER_CLIENT_ID = "client-id";
  process.env.TWITTER_REDIRECT_URI = "http://localhost/callback";
  expect(() => validateEnvironment()).not.toThrow();

  resetExampleEnv();
  process.env.XAI_API_KEY = "xai-test-key";
  process.env.TWITTER_AUTH_MODE = "env";
  expect(() => validateEnvironment()).toThrow("TWITTER_API_KEY");

  process.env.TWITTER_API_KEY = "api-key";
  process.env.TWITTER_API_SECRET_KEY = "api-secret";
  process.env.TWITTER_ACCESS_TOKEN = "access-token";
  process.env.TWITTER_ACCESS_TOKEN_SECRET = "access-secret";
  expect(() => validateEnvironment()).not.toThrow();
});

test("validateEnvironment rejects invalid auth modes and missing model key", () => {
  resetExampleEnv();
  expect(() => validateEnvironment()).toThrow("XAI_API_KEY");

  process.env.XAI_API_KEY = "xai-test-key";
  process.env.TWITTER_AUTH_MODE = "cookies";
  expect(() => validateEnvironment()).toThrow(
    "Invalid TWITTER_AUTH_MODE=cookies",
  );
});

test("auth mode defaults to env (the mode plugin-x supports standalone)", () => {
  // With TWITTER_AUTH_MODE unset, the example must default to `env` — the only
  // mode @elizaos/plugin-x implements standalone — not the unimplemented
  // `broker`. Proven by the env-mode credential check firing.
  resetExampleEnv();
  process.env.XAI_API_KEY = "xai-test-key";
  expect(() => validateEnvironment()).toThrow("TWITTER_API_KEY");
});

test("runtime resolves POSTGRES_URL from the environment via the settings bridge", () => {
  // Regression for #10166: core getSetting() does not read process.env, so the
  // headless host must merge env into settings. Without the bridge, plugin-sql's
  // getSetting("POSTGRES_URL") misses the .env value and falls back to PGlite.
  resetExampleEnv();
  process.env.POSTGRES_URL = "postgresql://user:pass@db.example:5432/eliza";
  const runtime = new AgentRuntime({
    character,
    settings: getBasicCapabilitiesSettings(character),
  });
  expect(runtime.getSetting("POSTGRES_URL")).toBe(
    "postgresql://user:pass@db.example:5432/eliza",
  );
});
