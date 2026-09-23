/**
 * Exercises the database-config env resolution in `eliza.ts`
 * (`applyDatabaseConfigToEnv`) and the `getSetting` binding installed by
 * `installRuntimeMethodBindings`: POSTGRES_URL/DATABASE_URL promotion and the
 * local-state PGlite-vs-shared-Postgres locality boundary (#8771/#8783).
 * Deterministic: uses a real uninitialized runtime with isolated environment settings and no live database.
 */
import { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ElizaConfig } from "../config/config.ts";
import {
  applyDatabaseConfigToEnv,
  installRuntimeMethodBindings,
} from "./eliza.ts";

const ENV_KEYS = [
  "POSTGRES_URL",
  "DATABASE_URL",
  "PGLITE_DATA_DIR",
  "ELIZA_DATABASE_PROVIDER",
  "SQLITE_DATABASE_PATH",
  "ELIZA_MANAGED_DATABASE_URL",
  "ELIZA_AGENT_LOCAL_STATE",
] as const;

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
  it("selects an absolute SQLite file without PostgreSQL or PGlite environment fallback", () => {
    process.env.ELIZA_DATABASE_PROVIDER = "sqlite";
    process.env.SQLITE_DATABASE_PATH = "/tmp/synthetic-agent/agent.sqlite";
    process.env.POSTGRES_URL = "postgres://synthetic/db";
    process.env.DATABASE_URL = "postgres://synthetic/db";
    process.env.PGLITE_DATA_DIR = "/tmp/old-pglite";
    applyDatabaseConfigToEnv({});
    expect(process.env.SQLITE_DATABASE_PATH).toBe(
      "/tmp/synthetic-agent/agent.sqlite",
    );
    expect(process.env.POSTGRES_URL).toBeUndefined();
    expect(process.env.DATABASE_URL).toBeUndefined();
    expect(process.env.PGLITE_DATA_DIR).toBeUndefined();
  });

  it("rejects an ambiguous database config or nonabsolute SQLite path before boot", () => {
    process.env.ELIZA_DATABASE_PROVIDER = "sqlite";
    process.env.SQLITE_DATABASE_PATH = "relative.sqlite";
    expect(() => applyDatabaseConfigToEnv({})).toThrow(
      expect.objectContaining({ code: "SQLITE_PATH_REQUIRED" }),
    );
    process.env.SQLITE_DATABASE_PATH = "/tmp/synthetic-agent/agent.sqlite";
    expect(() =>
      applyDatabaseConfigToEnv({ database: { provider: "pglite" } }),
    ).toThrow(expect.objectContaining({ code: "DATABASE_PROVIDER_CONFLICT" }));
  });

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

  it("boots PGlite when only ELIZA_MANAGED_DATABASE_URL is set (local-state container) (#8771/#8783)", () => {
    // The managed-url is deliberately NOT one of the keys resolveEffectiveDbProvider
    // reads, so a local-state agent carrying only ELIZA_MANAGED_DATABASE_URL (the
    // opt-in marker) + the local-state flag stays on PGlite — never the shared
    // remote Postgres. This is the consumer-side half of the locality fix.
    process.env.ELIZA_MANAGED_DATABASE_URL = "postgres://shared/db";
    process.env.ELIZA_AGENT_LOCAL_STATE = "1";

    applyDatabaseConfigToEnv({} as ElizaConfig);

    expect(process.env.POSTGRES_URL).toBeUndefined();
    expect(process.env.PGLITE_DATA_DIR).toBeTruthy();
  });

  it("an explicit DATABASE_URL still wins over ELIZA_AGENT_LOCAL_STATE (documented boundary)", () => {
    // local-state does NOT override an explicit caller DATABASE_URL — that is the
    // exact 'if any env path re-introduces DATABASE_URL the locality breaks'
    // boundary. Pin the behavior so a future change is a conscious one.
    process.env.DATABASE_URL = "postgresql://own@127.0.0.1:5432/elizaos";
    process.env.ELIZA_AGENT_LOCAL_STATE = "1";
    process.env.ELIZA_MANAGED_DATABASE_URL = "postgres://shared/db";

    applyDatabaseConfigToEnv({} as ElizaConfig);

    expect(process.env.POSTGRES_URL).toBe(
      "postgresql://own@127.0.0.1:5432/elizaos",
    );
    expect(process.env.PGLITE_DATA_DIR).toBeUndefined();
  });

  it("exposes database env vars through runtime.getSetting", () => {
    process.env.POSTGRES_URL = "postgresql://elizaos@127.0.0.1:5432/elizaos";
    process.env.DATABASE_URL = "postgresql://fallback@127.0.0.1:5432/elizaos";

    const runtime = new AgentRuntime({
      character: { name: "database-settings-fixture", bio: [], settings: {} },
      logLevel: "fatal",
    });

    installRuntimeMethodBindings(runtime);

    expect(runtime.getSetting("POSTGRES_URL")).toBe(
      "postgresql://elizaos@127.0.0.1:5432/elizaos",
    );
    expect(runtime.getSetting("DATABASE_URL")).toBe(
      "postgresql://fallback@127.0.0.1:5432/elizaos",
    );
  });
});
