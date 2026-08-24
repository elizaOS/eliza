/**
 * Pins database URL resolution. The consequential property is the fail-closed
 * one: production and CI must never silently fall back to a local file-backed
 * PGlite store, and the opt-out kill switch must win over that fallback. Also
 * covers explicit-URL precedence and the non-clobbering mutation contract of
 * applyDatabaseUrlFallback. Every case injects its own env; process.env is
 * never read or mutated.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  applyDatabaseUrlFallback,
  getLocalPGliteDatabaseUrl,
  resolveDatabaseUrl,
} from "./database-url";

const REMOTE = "postgres://user:pw@db.example.com:5432/prod";
const TEST_REMOTE = "postgres://user:pw@db.example.com:5432/test";

/** A local-dev env: not production, not CI. */
const local = (over: Record<string, string | undefined> = {}) => ({
  NODE_ENV: "development",
  ...over,
});

describe("getLocalPGliteDatabaseUrl", () => {
  test("resolves the default data dir to an absolute pglite url", () => {
    const url = getLocalPGliteDatabaseUrl({});
    expect(url.startsWith("pglite://")).toBe(true);
    expect(path.isAbsolute(url.slice("pglite://".length))).toBe(true);
  });

  test("prefers PGLITE_DATA_DIR over LOCAL_DATABASE_PATH", () => {
    const url = getLocalPGliteDatabaseUrl({
      PGLITE_DATA_DIR: "/tmp/chosen",
      LOCAL_DATABASE_PATH: "/tmp/ignored",
    });
    expect(url).toBe("pglite:///tmp/chosen");
  });

  test("falls back to LOCAL_DATABASE_PATH when PGLITE_DATA_DIR is absent", () => {
    expect(getLocalPGliteDatabaseUrl({ LOCAL_DATABASE_PATH: "/tmp/fallback" })).toBe(
      "pglite:///tmp/fallback",
    );
  });

  test("treats a blank override as unset", () => {
    const blank = getLocalPGliteDatabaseUrl({ PGLITE_DATA_DIR: "" });
    expect(blank).toBe(getLocalPGliteDatabaseUrl({}));
  });

  test("resolves a relative dir against the working directory", () => {
    expect(getLocalPGliteDatabaseUrl({ PGLITE_DATA_DIR: "relative/store" })).toBe(
      `pglite://${path.resolve(process.cwd(), "relative/store")}`,
    );
  });

  test("leaves an already-absolute dir untouched", () => {
    expect(getLocalPGliteDatabaseUrl({ PGLITE_DATA_DIR: path.resolve("/var/data") })).toBe(
      `pglite://${path.resolve("/var/data")}`,
    );
  });

  test("is stable across calls with the same env", () => {
    const env = local({ PGLITE_DATA_DIR: "some/dir" });
    expect(getLocalPGliteDatabaseUrl(env)).toBe(getLocalPGliteDatabaseUrl(env));
  });
});

describe("resolveDatabaseUrl — explicit URLs win", () => {
  test("TEST_DATABASE_URL outranks DATABASE_URL", () => {
    expect(resolveDatabaseUrl({ TEST_DATABASE_URL: TEST_REMOTE, DATABASE_URL: REMOTE })).toBe(
      TEST_REMOTE,
    );
  });

  test("DATABASE_URL is used when TEST_DATABASE_URL is absent or blank", () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: REMOTE })).toBe(REMOTE);
    expect(resolveDatabaseUrl({ TEST_DATABASE_URL: "", DATABASE_URL: REMOTE })).toBe(REMOTE);
  });

  test("an explicit URL wins in production", () => {
    expect(resolveDatabaseUrl({ NODE_ENV: "production", DATABASE_URL: REMOTE })).toBe(REMOTE);
  });

  test("an explicit URL wins over the kill switch", () => {
    expect(
      resolveDatabaseUrl({
        DISABLE_LOCAL_PGLITE_FALLBACK: "1",
        DATABASE_URL: REMOTE,
      }),
    ).toBe(REMOTE);
  });
});

describe("resolveDatabaseUrl — fail closed", () => {
  test("production never falls back to a local store", () => {
    const url = resolveDatabaseUrl({ NODE_ENV: "production" });
    expect(url).toBeNull();
  });

  test("CI never falls back to a local store", () => {
    expect(resolveDatabaseUrl({ NODE_ENV: "development", CI: "true" })).toBeNull();
    expect(resolveDatabaseUrl({ NODE_ENV: "test", CI: "true" })).toBeNull();
  });

  test("the kill switch suppresses the fallback in local execution", () => {
    expect(resolveDatabaseUrl(local({ DISABLE_LOCAL_PGLITE_FALLBACK: "1" }))).toBeNull();
  });

  test("the kill switch is exact — only the string '1' disables", () => {
    for (const value of ["0", "true", "yes", "", " 1", "1 "]) {
      expect(resolveDatabaseUrl(local({ DISABLE_LOCAL_PGLITE_FALLBACK: value }))).not.toBeNull();
    }
  });

  test("no resolved URL is ever a pglite store outside local execution", () => {
    for (const env of [
      { NODE_ENV: "production" },
      { NODE_ENV: "production", CI: "true" },
      { NODE_ENV: "development", CI: "true" },
    ]) {
      expect(resolveDatabaseUrl(env)).toBeNull();
    }
  });
});

describe("resolveDatabaseUrl — local fallback", () => {
  test("falls back to PGlite in local development", () => {
    expect(resolveDatabaseUrl(local())).toBe(getLocalPGliteDatabaseUrl(local()));
  });

  test("falls back for test and for an unset NODE_ENV", () => {
    for (const env of [{ NODE_ENV: "test" }, {}]) {
      expect(resolveDatabaseUrl(env)?.startsWith("pglite://")).toBe(true);
    }
  });

  test("honours the data-dir override on the fallback path", () => {
    expect(resolveDatabaseUrl(local({ PGLITE_DATA_DIR: "/tmp/x" }))).toBe("pglite:///tmp/x");
  });

  test("CI set to anything but 'true' is still local", () => {
    expect(resolveDatabaseUrl(local({ CI: "false" }))?.startsWith("pglite://")).toBe(true);
  });
});

describe("applyDatabaseUrlFallback", () => {
  test("writes the resolved URL into DATABASE_URL", () => {
    const env = local();
    const url = applyDatabaseUrlFallback(env);
    expect(url).not.toBeNull();
    expect(env.DATABASE_URL).toBe(url as string);
  });

  test("never clobbers an existing DATABASE_URL", () => {
    const env = local({ DATABASE_URL: REMOTE });
    expect(applyDatabaseUrlFallback(env)).toBe(REMOTE);
    expect(env.DATABASE_URL).toBe(REMOTE);
  });

  test("leaves DATABASE_URL alone even when the resolved URL differs", () => {
    // TEST_DATABASE_URL outranks DATABASE_URL, so the resolved value is NOT
    // the one already in DATABASE_URL. A plain assignment would overwrite the
    // production handle with the test one; `??=` must not.
    const env = local({
      DATABASE_URL: REMOTE,
      TEST_DATABASE_URL: TEST_REMOTE,
    });
    expect(applyDatabaseUrlFallback(env)).toBe(TEST_REMOTE);
    expect(env.DATABASE_URL).toBe(REMOTE);
  });

  test("sets TEST_DATABASE_URL only under NODE_ENV=test", () => {
    const testEnv: Record<string, string | undefined> = { NODE_ENV: "test" };
    applyDatabaseUrlFallback(testEnv);
    expect(testEnv.TEST_DATABASE_URL).toBe(testEnv.DATABASE_URL);

    const devEnv: Record<string, string | undefined> = local();
    applyDatabaseUrlFallback(devEnv);
    expect(devEnv.TEST_DATABASE_URL).toBeUndefined();
  });

  test("never clobbers an existing TEST_DATABASE_URL", () => {
    const env: Record<string, string | undefined> = {
      NODE_ENV: "test",
      TEST_DATABASE_URL: TEST_REMOTE,
    };
    applyDatabaseUrlFallback(env);
    expect(env.TEST_DATABASE_URL).toBe(TEST_REMOTE);
  });

  test("leaves env untouched when nothing resolves", () => {
    const env: Record<string, string | undefined> = { NODE_ENV: "production" };
    expect(applyDatabaseUrlFallback(env)).toBeNull();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.TEST_DATABASE_URL).toBeUndefined();
  });

  test("is idempotent", () => {
    const env = local();
    const first = applyDatabaseUrlFallback(env);
    const snapshot = { ...env };
    expect(applyDatabaseUrlFallback(env)).toBe(first as string);
    expect(env).toEqual(snapshot);
  });

  test("agrees with resolveDatabaseUrl on a fresh env", () => {
    for (const base of [
      local(),
      { NODE_ENV: "production" },
      local({ DISABLE_LOCAL_PGLITE_FALLBACK: "1" }),
      { DATABASE_URL: REMOTE },
    ]) {
      expect(applyDatabaseUrlFallback({ ...base })).toBe(resolveDatabaseUrl({ ...base }));
    }
  });
});
