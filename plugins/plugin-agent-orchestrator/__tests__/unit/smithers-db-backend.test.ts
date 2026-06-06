/**
 * Unit tests for Smithers database backend selection in plugin-agent-orchestrator.
 *
 * The selection logic lives in `resolveSmithersDbConfig` (env → payload) and
 * the inline subprocess script (payload.dbConfig → Smithers layer). These tests
 * exercise:
 *   1. resolveSmithersDbConfig: default sqlite / postgres / pglite / unknown→sqlite
 *   2. Subprocess layer-selection logic: correct branch chosen + feature-detect
 *      fallback when the API method is absent.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSmithersDbConfig } from "../../src/services/smithers-task-runner";

// ---------------------------------------------------------------------------
// resolveSmithersDbConfig
// ---------------------------------------------------------------------------

describe("resolveSmithersDbConfig", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    for (const key of [
      "SMITHERS_DB_PROVIDER",
      "SMITHERS_DB_URL",
      "SMITHERS_DB_DATA_DIR",
    ]) {
      if (key in savedEnv) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it("defaults to sqlite when SMITHERS_DB_PROVIDER is unset", () => {
    delete process.env.SMITHERS_DB_PROVIDER;
    const config = resolveSmithersDbConfig();
    expect(config.provider).toBe("sqlite");
    expect(config.connectionString).toBeUndefined();
    expect(config.dataDir).toBeUndefined();
  });

  it("returns provider=sqlite when SMITHERS_DB_PROVIDER=sqlite", () => {
    process.env.SMITHERS_DB_PROVIDER = "sqlite";
    const config = resolveSmithersDbConfig();
    expect(config.provider).toBe("sqlite");
  });

  it("returns provider=postgres and connectionString when SMITHERS_DB_PROVIDER=postgres", () => {
    process.env.SMITHERS_DB_PROVIDER = "postgres";
    process.env.SMITHERS_DB_URL = "postgresql://user:pass@localhost:5432/db";
    const config = resolveSmithersDbConfig();
    expect(config.provider).toBe("postgres");
    expect(config.connectionString).toBe(
      "postgresql://user:pass@localhost:5432/db",
    );
  });

  it("returns provider=pglite and dataDir when SMITHERS_DB_PROVIDER=pglite", () => {
    process.env.SMITHERS_DB_PROVIDER = "pglite";
    process.env.SMITHERS_DB_DATA_DIR = "/tmp/pglite-data";
    const config = resolveSmithersDbConfig();
    expect(config.provider).toBe("pglite");
    expect(config.dataDir).toBe("/tmp/pglite-data");
  });

  it("falls back to sqlite for an unknown SMITHERS_DB_PROVIDER value", () => {
    process.env.SMITHERS_DB_PROVIDER = "mysql";
    const config = resolveSmithersDbConfig();
    expect(config.provider).toBe("sqlite");
  });
});

// ---------------------------------------------------------------------------
// Subprocess layer-selection logic (extracted and tested in isolation)
// ---------------------------------------------------------------------------

/**
 * Replicates the inline branch from createTaskScript so we can unit-test it
 * without spawning a real subprocess. The logic is identical to what the script
 * string does:
 *
 *   const provider = dbConfig.provider ?? 'sqlite';
 *   if (provider !== 'sqlite' && typeof Smithers[provider] === 'function') { … }
 *   else { Smithers.sqlite({ filename }) }
 */
function selectSmithersLayer(
  Smithers: Record<string, unknown>,
  dbConfig: {
    provider?: string;
    connectionString?: string;
    dataDir?: string;
  },
  dbPath: string,
): { method: string; arg: Record<string, unknown> } {
  const provider = dbConfig.provider ?? "sqlite";
  if (provider !== "sqlite" && typeof Smithers[provider] === "function") {
    if (provider === "postgres") {
      return {
        method: "postgres",
        arg: { connectionString: dbConfig.connectionString },
      };
    }
    if (provider === "pglite") {
      return { method: "pglite", arg: { dataDir: dbConfig.dataDir } };
    }
  }
  return { method: "sqlite", arg: { filename: dbPath } };
}

describe("subprocess layer-selection logic", () => {
  const DB_PATH = "/tmp/task.sqlite";

  it("selects sqlite by default (empty dbConfig)", () => {
    const Smithers = { sqlite: () => "sqlite-layer" };
    const result = selectSmithersLayer(Smithers, {}, DB_PATH);
    expect(result.method).toBe("sqlite");
    expect(result.arg).toEqual({ filename: DB_PATH });
  });

  it("selects sqlite when provider=sqlite", () => {
    const Smithers = { sqlite: () => "sqlite-layer" };
    const result = selectSmithersLayer(
      Smithers,
      { provider: "sqlite" },
      DB_PATH,
    );
    expect(result.method).toBe("sqlite");
    expect(result.arg).toEqual({ filename: DB_PATH });
  });

  it("selects postgres when provider=postgres and Smithers.postgres is a function", () => {
    const Smithers = {
      sqlite: () => "sqlite-layer",
      postgres: () => "postgres-layer",
    };
    const result = selectSmithersLayer(
      Smithers,
      { provider: "postgres", connectionString: "postgresql://localhost/db" },
      DB_PATH,
    );
    expect(result.method).toBe("postgres");
    expect(result.arg).toEqual({
      connectionString: "postgresql://localhost/db",
    });
  });

  it("selects pglite when provider=pglite and Smithers.pglite is a function", () => {
    const Smithers = {
      sqlite: () => "sqlite-layer",
      pglite: () => "pglite-layer",
    };
    const result = selectSmithersLayer(
      Smithers,
      { provider: "pglite", dataDir: "/tmp/pglite" },
      DB_PATH,
    );
    expect(result.method).toBe("pglite");
    expect(result.arg).toEqual({ dataDir: "/tmp/pglite" });
  });

  it("falls back to sqlite when provider=postgres but Smithers.postgres is absent", () => {
    // Simulates smithers-orchestrator@0.22.0 which lacks these methods.
    const Smithers = { sqlite: () => "sqlite-layer" };
    const result = selectSmithersLayer(
      Smithers,
      { provider: "postgres", connectionString: "postgresql://localhost/db" },
      DB_PATH,
    );
    expect(result.method).toBe("sqlite");
    expect(result.arg).toEqual({ filename: DB_PATH });
  });

  it("falls back to sqlite when provider=pglite but Smithers.pglite is absent", () => {
    const Smithers = { sqlite: () => "sqlite-layer" };
    const result = selectSmithersLayer(
      Smithers,
      { provider: "pglite", dataDir: "/tmp/pglite" },
      DB_PATH,
    );
    expect(result.method).toBe("sqlite");
    expect(result.arg).toEqual({ filename: DB_PATH });
  });
});
