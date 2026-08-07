/**
 * Unit tests for Smithers database backend selection in plugin-agent-orchestrator.
 *
 * The selection logic lives in `resolveSmithersDbConfig` (env → payload) and
 * the inline subprocess script (payload.dbConfig → Smithers layer). These tests
 * exercise:
 *   1. resolveSmithersDbConfig: valid backends and required connection details
 *   2. Subprocess layer selection fails instead of silently changing storage.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSmithersWorkerEnv,
  resolveSmithersDbConfig,
  resolveSmithersTimeoutMs,
  resolveTaskDbPath,
} from "../../src/services/smithers-task-runner";

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

  it("rejects an unknown SMITHERS_DB_PROVIDER value", () => {
    process.env.SMITHERS_DB_PROVIDER = "mysql";
    expect(() => resolveSmithersDbConfig()).toThrow(
      "Unsupported Smithers database provider",
    );
  });

  it("requires a connection string for postgres", () => {
    process.env.SMITHERS_DB_PROVIDER = "postgres";
    delete process.env.SMITHERS_DB_URL;
    expect(() => resolveSmithersDbConfig()).toThrow(
      "SMITHERS_DB_URL is required",
    );
  });

  it("requires a data directory for pglite", () => {
    process.env.SMITHERS_DB_PROVIDER = "pglite";
    delete process.env.SMITHERS_DB_DATA_DIR;
    expect(() => resolveSmithersDbConfig()).toThrow(
      "SMITHERS_DB_DATA_DIR is required",
    );
  });
});

describe("resolveTaskDbPath", () => {
  it("isolates the same task id into distinct tenant directories", () => {
    const taskId = "shared-task";
    const tenantA = resolveTaskDbPath("tenant-a", taskId);
    const tenantB = resolveTaskDbPath("tenant-b", taskId);

    expect(tenantA).not.toBe(tenantB);
    expect(resolveTaskDbPath("tenant-a", taskId)).toBe(tenantA);
    expect(tenantA).toContain("/.eliza/smithers-tasks/");
  });

  it("prevents path traversal and rejects an absent tenant boundary", () => {
    const path = resolveTaskDbPath("../../tenant", "../../task");
    expect(path).not.toContain("../");
    expect(() => resolveTaskDbPath("   ", "task")).toThrow(
      "tenant id is required",
    );
  });
});

describe("Smithers worker isolation", () => {
  it("does not forward provider credentials or task payloads through the environment", () => {
    const previousSecret = process.env.ANTHROPIC_API_KEY;
    const previousPayload = process.env.ELIZA_TASK_RUN_PAYLOAD;
    const previousMsgpackSetting =
      process.env.MSGPACKR_NATIVE_ACCELERATION_DISABLED;
    process.env.ANTHROPIC_API_KEY = "must-not-leak";
    process.env.ELIZA_TASK_RUN_PAYLOAD = "must-use-pipe";
    process.env.MSGPACKR_NATIVE_ACCELERATION_DISABLED = "true";
    try {
      const env = buildSmithersWorkerEnv();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.ELIZA_TASK_RUN_PAYLOAD).toBeUndefined();
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.MSGPACKR_NATIVE_ACCELERATION_DISABLED).toBe("true");
    } finally {
      if (previousSecret === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousSecret;
      if (previousPayload === undefined)
        delete process.env.ELIZA_TASK_RUN_PAYLOAD;
      else process.env.ELIZA_TASK_RUN_PAYLOAD = previousPayload;
      if (previousMsgpackSetting === undefined)
        delete process.env.MSGPACKR_NATIVE_ACCELERATION_DISABLED;
      else
        process.env.MSGPACKR_NATIVE_ACCELERATION_DISABLED =
          previousMsgpackSetting;
    }
  });

  it("rejects invalid execution timeouts", () => {
    expect(() => resolveSmithersTimeoutMs(0)).toThrow("positive number");
    expect(resolveSmithersTimeoutMs(1234)).toBe(1234);
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
 *   sqlite → Smithers.sqlite; configured remote backends must exist or throw.
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
  if (provider === "sqlite") {
    return { method: "sqlite", arg: { filename: dbPath } };
  }
  if (provider === "postgres" && typeof Smithers.postgres === "function") {
    return {
      method: "postgres",
      arg: { connectionString: dbConfig.connectionString },
    };
  }
  if (provider === "pglite" && typeof Smithers.pglite === "function") {
    return { method: "pglite", arg: { dataDir: dbConfig.dataDir } };
  }
  throw new Error(`Configured Smithers backend is unavailable: ${provider}`);
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

  it("fails when provider=postgres but Smithers.postgres is absent", () => {
    const Smithers = { sqlite: () => "sqlite-layer" };
    expect(() =>
      selectSmithersLayer(
        Smithers,
        { provider: "postgres", connectionString: "postgresql://localhost/db" },
        DB_PATH,
      ),
    ).toThrow("Configured Smithers backend is unavailable");
  });

  it("fails when provider=pglite but Smithers.pglite is absent", () => {
    const Smithers = { sqlite: () => "sqlite-layer" };
    expect(() =>
      selectSmithersLayer(
        Smithers,
        { provider: "pglite", dataDir: "/tmp/pglite" },
        DB_PATH,
      ),
    ).toThrow("Configured Smithers backend is unavailable");
  });
});
