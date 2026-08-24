/**
 * Unit coverage for plugin-sql node path/env resolution — tilde expansion,
 * .env discovery walking up from a start directory, and the PGlite data
 * directory resolution with monorepo detection and env overrides. A wrong
 * resolution here would point the adapter at the wrong on-disk database or
 * silently read the wrong .env during startup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
  ElizaError: class ElizaError extends Error {
    code?: string;
    context?: unknown;
    constructor(message: string, opts?: { code?: string; context?: unknown; cause?: unknown }) {
      super(message);
      this.code = opts?.code;
      this.context = opts?.context;
    }
  },
}));

vi.mock("dotenv", () => ({
  default: {
    config: vi.fn(() => {
      process.env.PGLITE_DATA_DIR = "/dotenv/db";
      return { parsed: {} };
    }),
  },
  config: vi.fn(() => {
    process.env.PGLITE_DATA_DIR = "/dotenv/db";
    return { parsed: {} };
  }),
}));

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expandTildePath, resolveEnvFile, resolvePgliteDir } from "./utils.node.ts";

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(tmpdir(), "sql-node-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("expandTildePath", () => {
  it("returns the path unchanged when it does not start with ~", () => {
    expect(expandTildePath("/data/db")).toBe("/data/db");
    expect(expandTildePath("relative/path")).toBe("relative/path");
  });

  it("joins a tilde prefix onto cwd", () => {
    const cwd = path.join(tempRoot, "app");
    mkdirSync(cwd, { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    expect(expandTildePath("~/data/db")).toBe(path.join(cwd, "/data/db"));
  });

  it("expands a bare tilde to cwd", () => {
    const cwd = path.join(tempRoot, "app");
    mkdirSync(cwd, { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    expect(expandTildePath("~")).toBe(cwd);
  });
});

describe("resolveEnvFile", () => {
  it("finds the .env in the start directory", () => {
    writeFileSync(path.join(tempRoot, ".env"), "A=1\n");
    expect(resolveEnvFile(tempRoot)).toBe(path.join(tempRoot, ".env"));
  });

  it("walks up parent directories to find a .env", () => {
    writeFileSync(path.join(tempRoot, ".env"), "A=1\n");
    const nested = path.join(tempRoot, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    expect(resolveEnvFile(nested)).toBe(path.join(tempRoot, ".env"));
  });

  it("returns the start-dir candidate when no .env exists above", () => {
    const nested = path.join(tempRoot, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(resolveEnvFile(nested)).toBe(path.join(nested, ".env"));
  });

  it("prefers the closest .env to the start directory", () => {
    writeFileSync(path.join(tempRoot, ".env"), "A=root\n");
    const nested = path.join(tempRoot, "a");
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(nested, ".env"), "A=nested\n");
    expect(resolveEnvFile(nested)).toBe(path.join(nested, ".env"));
  });

  it("defaults to process.cwd() when no start dir is given", () => {
    const cwd = path.join(tempRoot, "cwd-app");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(path.join(cwd, ".env"), "A=1\n");
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    expect(resolveEnvFile()).toBe(path.join(cwd, ".env"));
  });
});

describe("resolvePgliteDir", () => {
  it("honors an explicit dir argument", () => {
    vi.stubEnv("ELIZA_BENCH_DISABLE_DOTENV", "1");
    expect(resolvePgliteDir("/explicit/db")).toBe("/explicit/db");
  });

  it("honors PGLITE_DATA_DIR over fallback", () => {
    vi.stubEnv("ELIZA_BENCH_DISABLE_DOTENV", "1");
    vi.stubEnv("PGLITE_DATA_DIR", "/from/env/db");
    expect(resolvePgliteDir(undefined, "/fallback/db")).toBe("/from/env/db");
  });

  it("uses the fallback dir when env is disabled and no env var is set", () => {
    vi.stubEnv("ELIZA_BENCH_DISABLE_DOTENV", "1");
    expect(resolvePgliteDir(undefined, "/fallback/db")).toBe("/fallback/db");
  });

  it("resolves a tilde-prefixed dir", () => {
    vi.stubEnv("ELIZA_BENCH_DISABLE_DOTENV", "1");
    const cwd = path.join(tempRoot, "app");
    mkdirSync(cwd, { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    expect(resolvePgliteDir("~/db", undefined)).toBe(path.join(cwd, "/db"));
  });

  it("detects a monorepo cwd and defaults under .eliza/.elizadb", () => {
    vi.stubEnv("ELIZA_BENCH_DISABLE_DOTENV", "1");
    const cwd = path.join(tempRoot, "repo");
    mkdirSync(path.join(cwd, "packages", "core"), { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    expect(resolvePgliteDir(undefined, undefined)).toBe(path.join(cwd, ".eliza", ".elizadb"));
  });

  it("detects a monorepo two levels up", () => {
    vi.stubEnv("ELIZA_BENCH_DISABLE_DOTENV", "1");
    // cwd sits inside a package, e.g. <repo>/packages/plugin-sql
    const cwd = path.join(tempRoot, "repo", "packages", "plugin-sql");
    mkdirSync(path.join(tempRoot, "repo", "packages", "core"), {
      recursive: true,
    });
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    expect(resolvePgliteDir(undefined, undefined)).toBe(
      path.join(tempRoot, "repo", ".eliza", ".elizadb")
    );
  });

  it("falls back to cwd/.eliza/.elizadb outside a monorepo", () => {
    vi.stubEnv("ELIZA_BENCH_DISABLE_DOTENV", "1");
    const cwd = path.join(tempRoot, "standalone");
    mkdirSync(cwd, { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    expect(resolvePgliteDir(undefined, undefined)).toBe(path.join(cwd, ".eliza", ".elizadb"));
  });

  it("loads .env when dotenv is not disabled", () => {
    const cwd = path.join(tempRoot, "env-app");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(path.join(cwd, ".env"), "PGLITE_DATA_DIR=/dotenv/db\n");
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    // dotenv mock writes PGLITE_DATA_DIR into the environment on config().
    expect(resolvePgliteDir(undefined, "/fallback/db")).toBe("/dotenv/db");
  });
});
