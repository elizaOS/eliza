/**
 * Colocated coverage for PGlite startup-error classification and managed
 * `.elizadb` quarantine. Drives the real module against the real filesystem.
 * `@elizaos/plugin-sql` is stubbed only to load its public error-code constants
 * without the plugin barrel's `@noble/hashes` graph; classification, path
 * parsing, and quarantine still run in-process.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getLastFailedPluginNames } from "@elizaos/agent";
import { resolveUserPath } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/plugin-sql", async () => {
  const errors = await import("@elizaos/plugin-sql/pglite/errors.ts");
  return {
    PGLITE_ERROR_CODES: errors.PGLITE_ERROR_CODES,
    PgliteInitError: errors.PgliteInitError,
    closePgliteSingleton: async () => ({
      closed: false,
      timedOut: false,
      error: undefined,
    }),
  };
});

import { PGLITE_ERROR_CODES, PgliteInitError } from "@elizaos/plugin-sql";
import {
  attemptPgliteAutoReset,
  getPgliteRecoveryRetrySkipPlugins,
  normalizePgliteStartupError,
} from "./pglite-recovery.ts";

const tempRoots: string[] = [];
const originalEnv: Record<string, string | undefined> = {};

function snapshotEnv(keys: string[]): void {
  for (const key of keys) {
    if (!(key in originalEnv)) originalEnv[key] = process.env[key];
  }
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(originalEnv)) {
    delete originalEnv[key];
  }
}

function tempRoot(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `pglite-recovery-${label}-`));
  tempRoots.push(dir);
  return dir;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isolateElizaHome(root: string): void {
  snapshotEnv([
    "ELIZA_CONFIG_PATH",
    "ELIZA_STATE_DIR",
    "ELIZA_PERSIST_CONFIG_PATH",
  ]);
  const stateDir = path.join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_CONFIG_PATH = path.join(stateDir, "eliza.json");
  delete process.env.ELIZA_PERSIST_CONFIG_PATH;
}

function corruptError(options: {
  message?: string;
  code?: string;
  dataDir?: string;
  cause?: unknown;
}): Error & { code?: string; dataDir?: string } {
  const err = new Error(options.message ?? "pglite failed", {
    cause: options.cause,
  }) as Error & { code?: string; dataDir?: string };
  if (options.code !== undefined) err.code = options.code;
  if (options.dataDir !== undefined) err.dataDir = options.dataDir;
  return err;
}

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv();
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("getPgliteRecoveryRetrySkipPlugins", () => {
  it("forwards the last-failed plugin names and returns a fresh array", () => {
    const first = getPgliteRecoveryRetrySkipPlugins();
    const live = getLastFailedPluginNames();

    expect(Array.isArray(first)).toBe(true);
    expect(first.every((name) => typeof name === "string")).toBe(true);
    expect(first).toEqual(live);

    first.push("must-not-leak-into-the-resolver");
    expect(getPgliteRecoveryRetrySkipPlugins()).toEqual(live);
  });
});

describe("normalizePgliteStartupError", () => {
  it("returns unrelated values unchanged", () => {
    const err = new Error("network down");
    expect(normalizePgliteStartupError(err)).toBe(err);
    expect(normalizePgliteStartupError("plain")).toBe("plain");
    expect(normalizePgliteStartupError(null)).toBeNull();
    expect(normalizePgliteStartupError(undefined)).toBeUndefined();
    expect(normalizePgliteStartupError(7)).toBe(7);
  });

  it("returns a MANUAL_RESET_REQUIRED Error identity, including PgliteInitError", () => {
    const err = new PgliteInitError(
      PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED,
      "reset me",
      { dataDir: "/tmp/.elizadb" },
    );
    expect(normalizePgliteStartupError(err)).toBe(err);
  });

  it("does not treat ACTIVE_LOCK as a recoverable reset", () => {
    const err = corruptError({
      code: PGLITE_ERROR_CODES.ACTIVE_LOCK,
      message: "locked",
    });
    expect(normalizePgliteStartupError(err)).toBe(err);
  });

  it("wraps CORRUPT_DATA and preserves the original as cause", () => {
    const dataDir = path.join(tempRoot("wrap"), ".elizadb");
    const err = corruptError({
      code: PGLITE_ERROR_CODES.CORRUPT_DATA,
      message: "pages unreadable",
      dataDir,
    });

    const wrapped = normalizePgliteStartupError(err) as Error & {
      code?: string;
      dataDir?: string;
    };

    expect(wrapped).not.toBe(err);
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.code).toBe(PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED);
    expect(wrapped.dataDir).toBe(dataDir);
    expect(wrapped.cause).toBe(err);
    expect(wrapped.message).toBe(
      `PGlite initialization failed for ${dataDir}: pages unreadable. Stop the app, then rename or delete only this directory before retrying: ${dataDir}`,
    );
  });

  it("wraps a plain MANUAL_RESET_REQUIRED object that is not an Error", () => {
    const dataDir = path.join(tempRoot("plain-object"), ".elizadb");
    const raw = {
      code: PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED,
      message: "object reset",
      dataDir,
    };

    const wrapped = normalizePgliteStartupError(raw) as Error & {
      code?: string;
      dataDir?: string;
    };

    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.code).toBe(PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED);
    expect(wrapped.dataDir).toBe(dataDir);
    expect(wrapped.cause).toBe(raw);
    expect(wrapped.message).toContain("object reset");
  });

  it("reads a reset code from a nested cause and skips empty codes", () => {
    const dataDir = path.join(tempRoot("cause"), ".elizadb");
    const leaf = corruptError({
      code: PGLITE_ERROR_CODES.CORRUPT_DATA,
      message: "leaf corrupt",
      dataDir,
    });
    const mid = corruptError({
      code: "",
      message: "wrapper",
      cause: leaf,
    });

    const wrapped = normalizePgliteStartupError(mid) as Error & {
      code?: string;
      dataDir?: string;
    };
    expect(wrapped.code).toBe(PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED);
    expect(wrapped.dataDir).toBe(dataDir);
    expect(wrapped.cause).toBe(mid);
  });

  it("stops walking a cyclic cause chain", () => {
    snapshotEnv(["PGLITE_DATA_DIR"]);
    process.env.PGLITE_DATA_DIR = path.join(tempRoot("cycle"), ".elizadb");
    const cyclic: { message: string; code: string; cause?: unknown } = {
      message: "aborted()",
      code: "",
    };
    cyclic.cause = cyclic;

    const wrapped = normalizePgliteStartupError(cyclic) as Error & {
      code?: string;
    };
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.code).toBe(PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED);
    expect(wrapped.cause).toBe(cyclic);
  });

  it("wraps each retained legacy signature and ignores partial plugin-sql text", () => {
    snapshotEnv(["PGLITE_DATA_DIR"]);
    process.env.PGLITE_DATA_DIR = path.join(tempRoot("legacy"), ".elizadb");

    const rename = new Error(
      "Rename or delete only this directory before retrying",
    );
    expect(
      (normalizePgliteStartupError(rename) as Error & { code?: string }).code,
    ).toBe(PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED);

    const abort = new Error("wasm ABORTED()");
    expect(
      (normalizePgliteStartupError(abort) as Error & { code?: string }).code,
    ).toBe(PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED);

    const both = new Error(
      "@elizaos/plugin-sql could not apply migrations._migrations",
    );
    expect(
      (normalizePgliteStartupError(both) as Error & { code?: string }).code,
    ).toBe(PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED);

    const pluginOnly = new Error("@elizaos/plugin-sql adapter crashed");
    expect(normalizePgliteStartupError(pluginOnly)).toBe(pluginOnly);

    const migrationOnly = new Error("failed at migrations._migrations");
    expect(normalizePgliteStartupError(migrationOnly)).toBe(migrationOnly);
  });

  it("prefers a trimmed dataDir property over a message path", () => {
    const dataDir = path.join(tempRoot("property"), ".elizadb");
    const err = new Error(
      `PGlite initialization failed for /message-path/.elizadb: boom`,
    ) as Error & { code?: string; dataDir?: string };
    err.code = PGLITE_ERROR_CODES.CORRUPT_DATA;
    err.dataDir = `  ${dataDir}  `;

    const wrapped = normalizePgliteStartupError(err) as Error & {
      dataDir?: string;
    };
    expect(wrapped.dataDir).toBe(`  ${dataDir}  `);
  });

  it("skips blank dataDir properties and parses an init-path from the message", () => {
    const dataDir = path.join(tempRoot("init-path"), ".elizadb");
    const err = new Error(
      `PGlite initialization failed for ${dataDir}: checksum`,
    ) as Error & { code?: string; dataDir?: string };
    err.code = PGLITE_ERROR_CODES.CORRUPT_DATA;
    err.dataDir = "   ";

    const wrapped = normalizePgliteStartupError(err) as Error & {
      dataDir?: string;
    };
    expect(wrapped.dataDir).toBe(dataDir);
  });

  it("parses a retry path but stops the capture at the first '.'", () => {
    const err = new Error(
      "Stop the app, then rename or delete only this directory before retrying: /var/lib/.elizadb",
    );
    const wrapped = normalizePgliteStartupError(err) as Error & {
      code?: string;
      dataDir?: string;
    };
    expect(wrapped.code).toBe(PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED);
    expect(wrapped.dataDir).toBe("/var/lib/");
  });

  it("captures a retry path that has no '.' when it sits at end of message", () => {
    const err = new Error(
      "rename or delete only this directory before retrying: /tmp/elizadb",
    );
    const wrapped = normalizePgliteStartupError(err) as Error & {
      dataDir?: string;
    };
    expect(wrapped.dataDir).toBe("/tmp/elizadb");
  });

  it("does not parse a retry path that lives past the 4096-character slice", () => {
    snapshotEnv(["PGLITE_DATA_DIR"]);
    const root = tempRoot("slice");
    const managed = path.join(root, ".elizadb");
    process.env.PGLITE_DATA_DIR = managed;

    const err = new Error(
      `${"x".repeat(4096)}rename or delete only this directory before retrying: /hidden/elizadb`,
    );
    const wrapped = normalizePgliteStartupError(err) as Error & {
      dataDir?: string;
    };
    expect(wrapped.dataDir).toBe(resolveUserPath(managed));
    expect(wrapped.dataDir).not.toBe("/hidden/elizadb");
  });

  it("falls back to PGLITE_DATA_DIR when the error has no data dir", () => {
    snapshotEnv(["PGLITE_DATA_DIR"]);
    const managed = path.join(tempRoot("env"), ".elizadb");
    process.env.PGLITE_DATA_DIR = managed;

    const err = corruptError({
      code: PGLITE_ERROR_CODES.CORRUPT_DATA,
      message: "no path on error",
    });
    const wrapped = normalizePgliteStartupError(err) as Error & {
      dataDir?: string;
    };
    expect(wrapped.dataDir).toBe(resolveUserPath(managed));
  });

  it("treats a whitespace-only PGLITE_DATA_DIR as unset and uses config dataDir", () => {
    snapshotEnv(["PGLITE_DATA_DIR"]);
    const root = tempRoot("config-dir");
    isolateElizaHome(root);
    process.env.PGLITE_DATA_DIR = "   ";
    const configured = path.join(root, "custom", ".elizadb");
    writeJson(process.env.ELIZA_CONFIG_PATH as string, {
      database: { provider: "pglite", pglite: { dataDir: configured } },
    });

    const err = corruptError({
      code: PGLITE_ERROR_CODES.CORRUPT_DATA,
      message: "config path",
    });
    const wrapped = normalizePgliteStartupError(err) as Error & {
      dataDir?: string;
    };
    expect(wrapped.dataDir).toBe(resolveUserPath(configured));
  });

  it("omits dataDir and uses the generic retry copy when the provider is postgres", () => {
    snapshotEnv(["PGLITE_DATA_DIR"]);
    const root = tempRoot("postgres");
    isolateElizaHome(root);
    delete process.env.PGLITE_DATA_DIR;
    writeJson(process.env.ELIZA_CONFIG_PATH as string, {
      database: { provider: "postgres" },
    });

    const err = corruptError({
      code: PGLITE_ERROR_CODES.CORRUPT_DATA,
      message: "cloud db",
    });
    const wrapped = normalizePgliteStartupError(err) as Error & {
      code?: string;
      dataDir?: string;
    };
    expect(wrapped.code).toBe(PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED);
    expect(wrapped.dataDir).toBeUndefined();
    expect(wrapped.message).toBe(
      "PGlite initialization failed: cloud db. Stop the app, then rename or delete only the managed PGlite data directory before retrying.",
    );
  });

  it("uses formatError when the reset error has no usable message", () => {
    snapshotEnv(["PGLITE_DATA_DIR"]);
    const managed = path.join(tempRoot("format"), ".elizadb");
    process.env.PGLITE_DATA_DIR = managed;
    const err = corruptError({
      code: PGLITE_ERROR_CODES.CORRUPT_DATA,
      message: "",
    });

    const wrapped = normalizePgliteStartupError(err) as Error;
    expect(wrapped.message).toContain(
      `PGlite initialization failed for ${resolveUserPath(managed)}: `,
    );
  });
});

describe("attemptPgliteAutoReset", () => {
  it("returns null for an empty or unrelated failure", async () => {
    await expect(attemptPgliteAutoReset(undefined)).resolves.toBeNull();
    await expect(
      attemptPgliteAutoReset(new Error("not a pglite failure")),
    ).resolves.toBeNull();
  });

  it("returns null for ACTIVE_LOCK even when the path is .elizadb", async () => {
    const dataDir = path.join(tempRoot("lock"), ".elizadb");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, "lockfile"), "held", "utf8");
    await expect(
      attemptPgliteAutoReset(
        corruptError({
          code: PGLITE_ERROR_CODES.ACTIVE_LOCK,
          dataDir,
        }),
      ),
    ).resolves.toBeNull();
    expect(readFileSync(path.join(dataDir, "lockfile"), "utf8")).toBe("held");
  });

  it("returns null when the data dir basename is not .elizadb", async () => {
    const dataDir = path.join(tempRoot("other"), "pglite");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, "marker"), "keep", "utf8");

    await expect(
      attemptPgliteAutoReset(
        corruptError({
          code: PGLITE_ERROR_CODES.CORRUPT_DATA,
          dataDir,
        }),
      ),
    ).resolves.toBeNull();
    expect(readFileSync(path.join(dataDir, "marker"), "utf8")).toBe("keep");
  });

  it("returns null when the source directory is missing", async () => {
    const dataDir = path.join(tempRoot("missing"), ".elizadb");
    await expect(
      attemptPgliteAutoReset(
        corruptError({
          code: PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED,
          dataDir,
        }),
      ),
    ).resolves.toBeNull();
  });

  it("returns null for postgres-managed boots with no dataDir on the error", async () => {
    snapshotEnv(["PGLITE_DATA_DIR"]);
    const root = tempRoot("pg-reset");
    isolateElizaHome(root);
    delete process.env.PGLITE_DATA_DIR;
    writeJson(process.env.ELIZA_CONFIG_PATH as string, {
      database: { provider: "postgres" },
    });

    await expect(
      attemptPgliteAutoReset(
        corruptError({
          code: PGLITE_ERROR_CODES.CORRUPT_DATA,
          message: "cloud",
        }),
      ),
    ).resolves.toBeNull();
  });

  it("quarantines a populated .elizadb onto a timestamped sibling", async () => {
    const root = tempRoot("move");
    const dataDir = path.join(root, ".elizadb");
    mkdirSync(path.join(dataDir, "sub"), { recursive: true });
    writeFileSync(path.join(dataDir, "state"), "ok", "utf8");
    writeFileSync(path.join(dataDir, "sub", "nested.txt"), "deep", "utf8");

    const now = 1_725_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    const backupDir = await attemptPgliteAutoReset(
      corruptError({
        code: PGLITE_ERROR_CODES.CORRUPT_DATA,
        dataDir,
      }),
    );
    const expected = path.join(root, `.elizadb.corrupt-${now}`);

    expect(backupDir).toBe(expected);
    expect(readFileSync(path.join(expected, "state"), "utf8")).toBe("ok");
    expect(readFileSync(path.join(expected, "sub", "nested.txt"), "utf8")).toBe(
      "deep",
    );
    await expect(
      import("node:fs/promises").then((fs) => fs.access(dataDir)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("quarantines an empty .elizadb directory for a legacy aborted() error", async () => {
    const root = tempRoot("empty");
    const dataDir = path.join(root, ".elizadb");
    mkdirSync(dataDir, { recursive: true });
    snapshotEnv(["PGLITE_DATA_DIR"]);
    process.env.PGLITE_DATA_DIR = dataDir;
    const now = 1_725_000_000_111;
    vi.spyOn(Date, "now").mockReturnValue(now);

    const moved = await attemptPgliteAutoReset(new Error("aborted()"));
    expect(moved).toBe(path.join(root, `.elizadb.corrupt-${now}`));
  });

  it("uses a numeric suffix when the first backup path already exists", async () => {
    const root = tempRoot("tie");
    const dataDir = path.join(root, ".elizadb");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, "marker"), "v2", "utf8");
    const now = 1_725_000_000_222;
    mkdirSync(path.join(root, `.elizadb.corrupt-${now}`));
    vi.spyOn(Date, "now").mockReturnValue(now);

    const backupDir = await attemptPgliteAutoReset(
      corruptError({
        code: PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED,
        dataDir,
      }),
    );

    expect(backupDir).toBe(path.join(root, `.elizadb.corrupt-${now}-1`));
    expect(readFileSync(path.join(backupDir as string, "marker"), "utf8")).toBe(
      "v2",
    );
  });

  it("throws when 1000 timestamped backup names are already taken", async () => {
    const root = tempRoot("overflow");
    const dataDir = path.join(root, ".elizadb");
    mkdirSync(dataDir, { recursive: true });
    const now = 1_725_000_000_333;
    mkdirSync(path.join(root, `.elizadb.corrupt-${now}`));
    for (let attempt = 1; attempt < 1000; attempt += 1) {
      mkdirSync(path.join(root, `.elizadb.corrupt-${now}-${attempt}`));
    }
    vi.spyOn(Date, "now").mockReturnValue(now);

    await expect(
      attemptPgliteAutoReset(
        corruptError({
          code: PGLITE_ERROR_CODES.CORRUPT_DATA,
          dataDir,
        }),
      ),
    ).rejects.toThrow(`Could not allocate a backup path for ${dataDir}`);
  });
});
