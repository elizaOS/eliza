/**
 * Unit tests for config-env: validates reading env keys with process.env fallbacks.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetDevCloudEnvAuthorityForTests } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfigCloudKey, readConfigEnvKey } from "./config-env.ts";

const ENV_KEYS = [
  "ELIZA_CONFIG_PATH",
  "ELIZA_DEV_SOURCE",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
  "ELIZA_CLOUD_URL",
] as const;
const savedEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;
const tempDirs: string[] = [];

beforeEach(() => {
  resetDevCloudEnvAuthorityForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  resetDevCloudEnvAuthorityForTests();
});

describe("config-env", () => {
  it("reads fallback key from process.env when present", () => {
    process.env.TEST_ELIZA_ORCHESTRATOR_KEY = "test-val-123";
    expect(readConfigEnvKey("TEST_ELIZA_ORCHESTRATOR_KEY")).toBe(
      "test-val-123",
    );
    delete process.env.TEST_ELIZA_ORCHESTRATOR_KEY;
  });

  it("returns undefined for non-existent config keys", () => {
    expect(readConfigEnvKey("DEFINITELY_NON_EXISTENT_ENV_KEY")).toBeUndefined();
    expect(
      readConfigCloudKey("DEFINITELY_NON_EXISTENT_CLOUD_KEY"),
    ).toBeUndefined();
  });

  it("ignores durable production Cloud values under staging authority", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-cloud-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "eliza.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        cloud: {
          apiKey: "persisted-production-key",
          baseUrl: "https://api.eliza.app/api/v1",
        },
        env: {
          ELIZA_CLOUD_URL: "https://api.eliza.app",
        },
      }),
    );
    process.env.ELIZA_CONFIG_PATH = configPath;
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-default";
    process.env.ELIZAOS_CLOUD_API_KEY = "";
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api-staging.eliza.app/api/v1";
    process.env.ELIZA_CLOUD_URL = "";

    expect(readConfigCloudKey("apiKey")).toBeUndefined();
    expect(readConfigCloudKey("baseUrl")).toBe(
      "https://api-staging.eliza.app/api/v1",
    );
    expect(readConfigEnvKey("ELIZA_CLOUD_URL")).toBeUndefined();
    expect(readConfigEnvKey("ELIZAOS_CLOUD_BASE_URL")).toBe(
      "https://api-staging.eliza.app/api/v1",
    );
  });
});
