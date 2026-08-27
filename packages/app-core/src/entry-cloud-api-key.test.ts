import {
  resetDevCloudEnvAuthorityForTests,
  resolveDevCloudAuthorityEnvValue,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promoteLauncherScopedDevCloudApiKey } from "./entry-cloud-api-key";

const PROCESS_ENV_KEYS = [
  "NODE_ENV",
  "ELIZA_DEV_SOURCE",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "ELIZA_DEV_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZA_DESKTOP_PACKAGED_RUNTIME",
] as const;

let savedProcessEnv: Record<string, string | undefined>;

beforeEach(() => {
  resetDevCloudEnvAuthorityForTests();
  savedProcessEnv = Object.fromEntries(
    PROCESS_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  for (const key of PROCESS_ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of PROCESS_ENV_KEYS) {
    const value = savedProcessEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetDevCloudEnvAuthorityForTests();
});

function explicitAuthority(
  authority: "staging-explicit" | "self-hosted" | "production",
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    ELIZA_DEV_SOURCE: "1",
    ELIZA_DEV_CLOUD_ENV_AUTHORITY: authority,
    ELIZA_DEV_CLOUD_API_KEY: "staging-specific-key",
  };
}

describe("entry Cloud API key promotion", () => {
  it("does not promote a staging-specific key when direct entry defaults to production", () => {
    const env: NodeJS.ProcessEnv = {
      ELIZA_DEV_CLOUD_API_KEY: "staging-specific-key",
    };

    expect(promoteLauncherScopedDevCloudApiKey(env)).toBe(false);
    expect(env.ELIZAOS_CLOUD_API_KEY).toBeUndefined();
  });

  it("does not promote a staging-specific key under production authority", () => {
    const env = explicitAuthority("production");

    expect(promoteLauncherScopedDevCloudApiKey(env)).toBe(false);
    expect(env.ELIZAOS_CLOUD_API_KEY).toBeUndefined();
  });

  it.each(["staging-explicit", "self-hosted"] as const)(
    "promotes the staging-specific key for %s launcher authority",
    (authority) => {
      const env = explicitAuthority(authority);

      expect(promoteLauncherScopedDevCloudApiKey(env)).toBe(true);
      expect(env.ELIZAOS_CLOUD_API_KEY).toBe("staging-specific-key");
    },
  );

  it("does not overwrite an existing canonical credential", () => {
    const env = explicitAuthority("staging-explicit");
    env.ELIZAOS_CLOUD_API_KEY = "canonical-key";

    expect(promoteLauncherScopedDevCloudApiKey(env)).toBe(false);
    expect(env.ELIZAOS_CLOUD_API_KEY).toBe("canonical-key");
  });

  it("does not promote from a production process even with compatible authority", () => {
    const env = explicitAuthority("staging-explicit");
    env.NODE_ENV = "production";

    expect(promoteLauncherScopedDevCloudApiKey(env)).toBe(false);
    expect(env.ELIZAOS_CLOUD_API_KEY).toBeUndefined();
  });

  it("does not promote inside a packaged desktop runtime", () => {
    const env = explicitAuthority("staging-explicit");
    env.ELIZA_DESKTOP_PACKAGED_RUNTIME = "1";

    expect(promoteLauncherScopedDevCloudApiKey(env)).toBe(false);
    expect(env.ELIZAOS_CLOUD_API_KEY).toBeUndefined();
  });

  it("promotes before the process authority snapshot freezes", () => {
    process.env.NODE_ENV = "development";
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
    process.env.ELIZA_DEV_CLOUD_API_KEY = "staging-specific-key";

    expect(promoteLauncherScopedDevCloudApiKey(process.env)).toBe(true);
    expect(resolveDevCloudAuthorityEnvValue("ELIZAOS_CLOUD_API_KEY")).toBe(
      "staging-specific-key",
    );
  });
});
