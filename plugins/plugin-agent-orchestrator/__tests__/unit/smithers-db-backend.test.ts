/**
 * Verifies Smithers setup boundaries for database selection and execution
 * deadlines. Tests cover environment-to-payload storage configuration, exact
 * timeout parsing, and the subprocess layer selection without a live worker.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSmithersWorkerEnv,
  resolveSmithersDbConfig,
  resolveSmithersTimeoutMs,
  resolveTaskDbPath,
  resolveTaskPgliteDataDir,
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

describe("resolveTaskPgliteDataDir", () => {
  const root = "/tmp/smithers-pglite";

  it("is stable for a durable run and isolates concurrent subprocesses", () => {
    const first = resolveTaskPgliteDataDir(root, "tenant-a", "task-a", "run-a");
    expect(resolveTaskPgliteDataDir(root, "tenant-a", "task-a", "run-a")).toBe(
      first,
    );
    expect(
      resolveTaskPgliteDataDir(root, "tenant-b", "task-a", "run-a"),
    ).not.toBe(first);
    expect(
      resolveTaskPgliteDataDir(root, "tenant-a", "task-b", "run-a"),
    ).not.toBe(first);
    expect(
      resolveTaskPgliteDataDir(root, "tenant-a", "task-a", "run-b"),
    ).not.toBe(first);
  });

  it("contains traversal-shaped identifiers beneath the configured root", () => {
    const dataDir = resolveTaskPgliteDataDir(
      root,
      "../../tenant",
      "../../task",
      "../../run",
    );
    const relativePath = relative(resolve(root), dataDir);
    expect(isAbsolute(relativePath)).toBe(false);
    expect(relativePath.split(sep)[0]).not.toBe("..");
  });

  it.each([
    ["tenant", "", "task", "run"],
    ["task", "tenant", "", "run"],
    ["run", "tenant", "task", ""],
  ])("rejects an absent %s boundary", (_name, tenantId, taskId, runId) => {
    expect(() =>
      resolveTaskPgliteDataDir(root, tenantId, taskId, runId),
    ).toThrow("is required");
  });
});

describe("Smithers worker isolation", () => {
  let previousTimeout: string | undefined;

  beforeEach(() => {
    previousTimeout = process.env.ELIZA_SMITHERS_TIMEOUT_MS;
    delete process.env.ELIZA_SMITHERS_TIMEOUT_MS;
  });

  afterEach(() => {
    if (previousTimeout === undefined) {
      delete process.env.ELIZA_SMITHERS_TIMEOUT_MS;
    } else {
      process.env.ELIZA_SMITHERS_TIMEOUT_MS = previousTimeout;
    }
  });

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

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["non-finite", Number.POSITIVE_INFINITY],
    ["unsafe", Number.MAX_SAFE_INTEGER],
    ["above the timer ceiling", 2_147_483_648],
  ])(
    "rejects an explicitly configured %s execution timeout",
    (_name, value) => {
      expect(() => resolveSmithersTimeoutMs(value)).toThrow(
        "integer from 1 through",
      );
    },
  );

  it.each([1, 1234, 2_147_483_647])(
    "accepts an explicit execution timeout at %i ms",
    (value) => {
      expect(resolveSmithersTimeoutMs(value)).toBe(value);
    },
  );

  it.each([
    "0",
    "-1",
    "1.5",
    "1e3",
    "1E3",
    "1e+3",
    "1e4",
    "01",
    "+1000",
    " 1000",
    "1000 ",
    "2147483648",
    "Infinity",
    "NaN",
  ])("rejects the non-canonical environment token %j", (raw) => {
    process.env.ELIZA_SMITHERS_TIMEOUT_MS = raw;

    expect(() => resolveSmithersTimeoutMs()).toThrow("integer from 1 through");
  });

  it("preserves the invalid environment token in structured error context", () => {
    process.env.ELIZA_SMITHERS_TIMEOUT_MS = "1e3";

    try {
      resolveSmithersTimeoutMs();
      throw new Error("expected timeout validation to fail");
    } catch (error) {
      expect(error).toMatchObject({
        name: "ElizaError",
        code: "SMITHERS_TIMEOUT_INVALID",
        context: {
          configured: "1e3",
          minimum: 1,
          maximum: 2_147_483_647,
        },
      });
    }
  });

  it("uses the default when the setting is absent or blank", () => {
    expect(resolveSmithersTimeoutMs()).toBe(300_000);
    process.env.ELIZA_SMITHERS_TIMEOUT_MS = "";
    expect(resolveSmithersTimeoutMs()).toBe(300_000);
  });

  it("accepts both live environment bounds", () => {
    process.env.ELIZA_SMITHERS_TIMEOUT_MS = "1";
    expect(resolveSmithersTimeoutMs()).toBe(1);
    process.env.ELIZA_SMITHERS_TIMEOUT_MS = "2147483647";
    expect(resolveSmithersTimeoutMs()).toBe(2_147_483_647);
  });

  it("gives a request override precedence over an invalid environment token", () => {
    process.env.ELIZA_SMITHERS_TIMEOUT_MS = "invalid";
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
 *   sqlite → Smithers.sqlite; configured alternate backends must exist or throw.
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

  it("fails when provider=pglite and Smithers.pglite is absent", () => {
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
