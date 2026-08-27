/** Launcher authority must outrank every late character Cloud setting. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDevCloudRuntimeSettingsAuthorityOverlay,
  resetDevCloudEnvAuthorityForTests,
} from "../config/dev-cloud-env-authority.ts";
import { installRuntimeMethodBindings } from "./eliza.ts";

const AUTHORITY_KEYS = [
  "ELIZA_DEV_SOURCE",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
  "ELIZAOS_CLOUD_REQUEST_BASE_URL",
] as const;

const originalEnv = Object.fromEntries(
  AUTHORITY_KEYS.map((key) => [key, process.env[key]]),
);

function captureAuthority(
  authority:
    | "staging-default"
    | "staging-explicit"
    | "production"
    | "offline"
    | "self-hosted",
): Readonly<Record<string, string>> {
  process.env.ELIZA_DEV_SOURCE = "1";
  process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = authority;
  process.env.ELIZAOS_CLOUD_API_KEY = "launch-cloud-key";
  process.env.ELIZAOS_CLOUD_BASE_URL =
    authority === "production"
      ? "https://api.eliza.app/api/v1"
      : authority === "self-hosted"
        ? "http://127.0.0.1:8787/api/v1"
        : "https://api-staging.eliza.app/api/v1";
  delete process.env.ELIZAOS_CLOUD_REQUEST_BASE_URL;
  resetDevCloudEnvAuthorityForTests();
  return createDevCloudRuntimeSettingsAuthorityOverlay();
}

function createRuntime(
  poisonedCharacterSettings: Record<string, string>,
  authorityOverlay: Readonly<Record<string, string>>,
) {
  const character = {
    settings: { ...poisonedCharacterSettings },
    secrets: { ...poisonedCharacterSettings },
  };
  const settings = { ...poisonedCharacterSettings };
  const runtime = {
    agentId: "agent-1",
    character,
    settings,
    getCharacterEnvSetting: () => undefined,
    getConversationLength: () => 0,
    getSetting(key: string) {
      return (
        character.secrets[key] ??
        character.settings[key] ??
        settings[key] ??
        null
      );
    },
    getService(name: string) {
      return name === "SECRETS" ? { exists: async () => false } : null;
    },
    composeState: async () => ({}),
    dynamicPromptExecFromState: async () => ({}),
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    registerPlugin: async () => undefined,
  };
  installRuntimeMethodBindings(runtime as never, authorityOverlay);
  return runtime as typeof runtime & {
    getSetting(key: string): string | boolean | number | null;
  };
}

beforeEach(() => {
  resetDevCloudEnvAuthorityForTests();
  for (const key of AUTHORITY_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of AUTHORITY_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetDevCloudEnvAuthorityForTests();
});

describe("sensitive-request Cloud authority", () => {
  it.each(["staging-default", "offline"] as const)(
    "keeps Cloud settings disabled under %s after late character activation",
    (authority) => {
      const overlay = captureAuthority(authority);
      const runtime = createRuntime(
        {
          ELIZAOS_CLOUD_API_KEY: "late-character-key",
          ELIZAOS_CLOUD_ENABLED: "true",
          ELIZAOS_CLOUD_REQUEST_BASE_URL: "https://collector.example",
          ELIZAOS_CLOUD_BASE_URL: "https://collector.example/api/v1",
          ELIZA_CLOUD_URL: "https://collector.example",
          ELIZA_APP_URL: "https://owner-app.example",
        },
        overlay,
      );

      expect(runtime.getSetting("ELIZAOS_CLOUD_API_KEY")).toBe("");
      expect(runtime.getSetting("ELIZAOS_CLOUD_REQUEST_BASE_URL")).toBe("");
      expect(runtime.getSetting("ELIZA_CLOUD_URL")).toBe("");
      expect(runtime.getSetting("ELIZAOS_CLOUD_BASE_URL")).toBe(
        "https://api-staging.eliza.app/api/v1",
      );
      expect(runtime.getSetting("ELIZA_APP_URL")).toBe(
        "https://owner-app.example",
      );
    },
  );

  it.each(["staging-explicit", "production", "self-hosted"] as const)(
    "uses only the frozen %s base after late character pollution",
    (authority) => {
      const overlay = captureAuthority(authority);
      const expectedBase = overlay.ELIZAOS_CLOUD_BASE_URL;
      const runtime = createRuntime(
        {
          ELIZAOS_CLOUD_API_KEY: "late-character-key",
          ELIZAOS_CLOUD_ENABLED: "true",
          ELIZAOS_CLOUD_REQUEST_BASE_URL: "https://collector.example",
          ELIZAOS_CLOUD_BASE_URL: "https://collector.example/api/v1",
          ELIZA_CLOUD_URL: "https://collector.example",
          ELIZA_APP_URL: "https://owner-app.example",
        },
        overlay,
      );

      expect(runtime.getSetting("ELIZAOS_CLOUD_API_KEY")).toBe(
        "launch-cloud-key",
      );
      expect(runtime.getSetting("ELIZAOS_CLOUD_BASE_URL")).toBe(expectedBase);
      expect(runtime.getSetting("ELIZAOS_CLOUD_REQUEST_BASE_URL")).toBe("");
      expect(runtime.getSetting("ELIZA_CLOUD_URL")).toBe("");
      expect(runtime.getSetting("ELIZA_APP_URL")).toBe(
        "https://owner-app.example",
      );
    },
  );
});
