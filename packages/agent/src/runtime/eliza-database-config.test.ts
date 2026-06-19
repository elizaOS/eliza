import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ElizaConfig } from "../config/config.ts";
import {
  applyDatabaseConfigToEnv,
  installRuntimeMethodBindings,
} from "./eliza.ts";

const ENV_KEYS = ["POSTGRES_URL", "DATABASE_URL", "PGLITE_DATA_DIR"] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("database runtime config", () => {
  it("preserves env-only POSTGRES_URL as the plugin-sql setting", () => {
    process.env.POSTGRES_URL = "postgresql://elizaos@127.0.0.1:5432/elizaos";
    process.env.PGLITE_DATA_DIR = "/tmp/should-not-use-pglite";

    applyDatabaseConfigToEnv({} as ElizaConfig);

    expect(process.env.POSTGRES_URL).toBe(
      "postgresql://elizaos@127.0.0.1:5432/elizaos",
    );
    expect(process.env.PGLITE_DATA_DIR).toBeUndefined();
  });

  it("promotes env-only DATABASE_URL to POSTGRES_URL for plugin-sql", () => {
    process.env.DATABASE_URL = "postgresql://elizaos@127.0.0.1:5432/elizaos";
    process.env.PGLITE_DATA_DIR = "/tmp/should-not-use-pglite";

    applyDatabaseConfigToEnv({} as ElizaConfig);

    expect(process.env.POSTGRES_URL).toBe(
      "postgresql://elizaos@127.0.0.1:5432/elizaos",
    );
    expect(process.env.PGLITE_DATA_DIR).toBeUndefined();
  });

  it("exposes database env vars through runtime.getSetting", () => {
    process.env.POSTGRES_URL = "postgresql://elizaos@127.0.0.1:5432/elizaos";
    process.env.DATABASE_URL = "postgresql://fallback@127.0.0.1:5432/elizaos";

    const runtime = {
      character: { settings: {}, secrets: {} },
      settings: {},
      getCharacterEnvSetting: () => undefined,
      getConversationLength: () => 0,
      getSetting: () => null,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    } as unknown as Parameters<typeof installRuntimeMethodBindings>[0];

    installRuntimeMethodBindings(runtime);

    expect(runtime.getSetting("POSTGRES_URL")).toBe(
      "postgresql://elizaos@127.0.0.1:5432/elizaos",
    );
    expect(runtime.getSetting("DATABASE_URL")).toBe(
      "postgresql://fallback@127.0.0.1:5432/elizaos",
    );
  });
});
