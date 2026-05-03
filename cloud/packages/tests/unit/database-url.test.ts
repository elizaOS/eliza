import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import {
  applyDatabaseUrlFallback,
  getLocalPGliteDatabaseUrl,
  LOCAL_PGLITE_DATABASE_URL,
  resolveDatabaseUrl,
} from "@/db/database-url";

type StringEnv = Record<string, string | undefined>;

const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("database URL fallback", () => {
  test("defaults to local PGlite for local test runs", () => {
    const env = {
      NODE_ENV: "test",
      DATABASE_URL: undefined,
      TEST_DATABASE_URL: undefined,
      PGLITE_DATA_DIR: "/tmp/eliza-pglite",
      CI: undefined,
      DISABLE_LOCAL_PGLITE_FALLBACK: undefined,
    };

    expect(resolveDatabaseUrl(env)).toBe("pglite:///tmp/eliza-pglite");
  });

  test("prefers explicit test database URL over the PGlite fallback", () => {
    const env = {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://app:pass@localhost:5432/app",
      TEST_DATABASE_URL: "postgresql://test:pass@localhost:5432/test",
      CI: undefined,
      DISABLE_LOCAL_PGLITE_FALLBACK: undefined,
    };

    expect(resolveDatabaseUrl(env)).toBe("postgresql://test:pass@localhost:5432/test");
  });

  test("exposes the canonical local PGlite URL constant", () => {
    expect(LOCAL_PGLITE_DATABASE_URL.startsWith("pglite://")).toBe(true);
    expect(LOCAL_PGLITE_DATABASE_URL.endsWith(".eliza/.pgdata")).toBe(true);
  });

  test("resolves PGlite paths to absolute directories", () => {
    expect(getLocalPGliteDatabaseUrl({ PGLITE_DATA_DIR: "/var/data/eliza" })).toBe(
      "pglite:///var/data/eliza",
    );
    expect(getLocalPGliteDatabaseUrl({ PGLITE_DATA_DIR: "relative/path" })).toBe(
      `pglite://${path.resolve(process.cwd(), "relative/path")}`,
    );
  });

  test("does not fall back in CI or production", () => {
    expect(
      resolveDatabaseUrl({
        NODE_ENV: "test",
        DATABASE_URL: undefined,
        TEST_DATABASE_URL: undefined,
        CI: "true",
        DISABLE_LOCAL_PGLITE_FALLBACK: undefined,
      }),
    ).toBeNull();

    expect(
      resolveDatabaseUrl({
        NODE_ENV: "production",
        DATABASE_URL: undefined,
        TEST_DATABASE_URL: undefined,
        CI: undefined,
        DISABLE_LOCAL_PGLITE_FALLBACK: undefined,
      }),
    ).toBeNull();
  });

  test("hydrates process.env when fallback is applied", () => {
    delete process.env.DATABASE_URL;
    delete process.env.TEST_DATABASE_URL;
    (process.env as StringEnv).NODE_ENV = "test";
    process.env.PGLITE_DATA_DIR = "/tmp/eliza-pglite";
    delete process.env.CI;
    delete process.env.DISABLE_LOCAL_PGLITE_FALLBACK;

    const applied = applyDatabaseUrlFallback(process.env as StringEnv);

    expect(applied).toBe("pglite:///tmp/eliza-pglite");
    expect((process.env as StringEnv).DATABASE_URL).toBe("pglite:///tmp/eliza-pglite");
    expect((process.env as StringEnv).TEST_DATABASE_URL).toBe("pglite:///tmp/eliza-pglite");
  });
});
