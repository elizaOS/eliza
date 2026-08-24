import { describe, expect, test } from "vitest";

import {
  getRuntimeDatabaseBackend,
  resolveRuntimeDatabaseAdapterConfig,
} from "./database-adapter-config";

describe("getRuntimeDatabaseBackend", () => {
  test("defaults to postgresql when no env", () => {
    expect(getRuntimeDatabaseBackend({})).toBe("postgresql");
    expect(getRuntimeDatabaseBackend({ DATABASE_ADAPTER: undefined })).toBe("postgresql");
  });

  test("recognizes postgresql aliases case-insensitive and trimmed", () => {
    expect(getRuntimeDatabaseBackend({ DATABASE_ADAPTER: "postgres" })).toBe("postgresql");
    expect(getRuntimeDatabaseBackend({ DATABASE_ADAPTER: "PostgreSQL" })).toBe("postgresql");
    expect(getRuntimeDatabaseBackend({ DATABASE_ADAPTER: " PG " })).toBe("postgresql");
    expect(getRuntimeDatabaseBackend({ DATABASE_ADAPTER: "neon" })).toBe("postgresql");
    expect(getRuntimeDatabaseBackend({ DATABASE_ADAPTER: "NEON" })).toBe("postgresql");
  });

  test("recognizes pglite aliases case-insensitive and trimmed", () => {
    expect(getRuntimeDatabaseBackend({ DATABASE_ADAPTER: "pglite" })).toBe("pglite");
    expect(getRuntimeDatabaseBackend({ DATABASE_ADAPTER: " PGLite " })).toBe("pglite");
    expect(getRuntimeDatabaseBackend({ DATABASE_ADAPTER: "local" })).toBe("pglite");
    expect(getRuntimeDatabaseBackend({ DATABASE_ADAPTER: "FILE" })).toBe("pglite");
    expect(getRuntimeDatabaseBackend({ DATABASE_ADAPTER: "sqlite" })).toBe("pglite");
    expect(getRuntimeDatabaseBackend({ DATABASE_ADAPTER: "SQLITE" })).toBe("pglite");
  });

  test("respects priority DATABASE_ADAPTER > DATABASE_ENGINE > DATABASE_DIALECT", () => {
    expect(
      getRuntimeDatabaseBackend({
        DATABASE_ADAPTER: "pglite",
        DATABASE_ENGINE: "postgresql",
        DATABASE_DIALECT: "postgresql",
      }),
    ).toBe("pglite");
    expect(
      getRuntimeDatabaseBackend({
        DATABASE_ENGINE: "pglite",
        DATABASE_DIALECT: "postgresql",
      }),
    ).toBe("pglite");
    expect(getRuntimeDatabaseBackend({ DATABASE_DIALECT: "pglite" })).toBe("pglite");
  });

  test("throws for unsupported backend", () => {
    expect(() => getRuntimeDatabaseBackend({ DATABASE_ADAPTER: "mysql" })).toThrow(
      "Unsupported DATABASE_ENGINE/DATABASE_DIALECT value: mysql",
    );
    expect(() => getRuntimeDatabaseBackend({ DATABASE_ADAPTER: "  unknown  " })).toThrow(
      "Unsupported DATABASE_ENGINE/DATABASE_DIALECT value: unknown",
    );
  });

  test("handles empty string as unsupported after trim", () => {
    expect(() => getRuntimeDatabaseBackend({ DATABASE_ADAPTER: "   " })).toThrow(
      "Unsupported DATABASE_ENGINE/DATABASE_DIALECT value:",
    );
  });
});

describe("resolveRuntimeDatabaseAdapterConfig", () => {
  test("pglite returns dataDir with default fallback", () => {
    expect(resolveRuntimeDatabaseAdapterConfig({ DATABASE_ADAPTER: "pglite" })).toEqual({
      dataDir: ".eliza/.elizadb",
    });
  });

  test("pglite prefers PGLITE_DATA_DIR over others", () => {
    expect(
      resolveRuntimeDatabaseAdapterConfig({
        DATABASE_ADAPTER: "pglite",
        PGLITE_DATA_DIR: "/custom/pglite",
        SQLITE_DATABASE_PATH: "/sqlite/path",
        LOCAL_DATABASE_PATH: "/local/path",
      }),
    ).toEqual({ dataDir: "/custom/pglite" });
  });

  test("pglite falls back through SQLITE_DATABASE_PATH etc", () => {
    expect(
      resolveRuntimeDatabaseAdapterConfig({
        DATABASE_ADAPTER: "pglite",
        SQLITE_DATABASE_PATH: "/sqlite/path",
      }),
    ).toEqual({ dataDir: "/sqlite/path" });
    expect(
      resolveRuntimeDatabaseAdapterConfig({
        DATABASE_ADAPTER: "pglite",
        SQLITE_DATABASE_URL: "/sqlite/url",
      }),
    ).toEqual({ dataDir: "/sqlite/url" });
    expect(
      resolveRuntimeDatabaseAdapterConfig({
        DATABASE_ADAPTER: "pglite",
        LOCAL_DATABASE_PATH: "/local/path",
      }),
    ).toEqual({ dataDir: "/local/path" });
  });

  test("postgresql requires POSTGRES_URL or DATABASE_URL", () => {
    expect(() => resolveRuntimeDatabaseAdapterConfig({ DATABASE_ADAPTER: "postgresql" })).toThrow(
      "DATABASE_URL environment variable is required",
    );
    expect(() =>
      resolveRuntimeDatabaseAdapterConfig({ DATABASE_ADAPTER: "pg", POSTGRES_URL: "" }),
    ).toThrow("DATABASE_URL environment variable is required");
  });

  test("postgresql prefers POSTGRES_URL over DATABASE_URL", () => {
    expect(
      resolveRuntimeDatabaseAdapterConfig({
        DATABASE_ADAPTER: "postgresql",
        POSTGRES_URL: "postgres://pg1",
        DATABASE_URL: "postgres://db1",
      }),
    ).toEqual({ postgresUrl: "postgres://pg1" });
    expect(
      resolveRuntimeDatabaseAdapterConfig({
        DATABASE_ADAPTER: "postgresql",
        DATABASE_URL: "postgres://db1",
      }),
    ).toEqual({ postgresUrl: "postgres://db1" });
  });

  test("pglite ignores postgres urls and returns only dataDir", () => {
    const cfg = resolveRuntimeDatabaseAdapterConfig({
      DATABASE_ADAPTER: "pglite",
      POSTGRES_URL: "postgres://should-be-ignored",
      DATABASE_URL: "postgres://also-ignored",
      PGLITE_DATA_DIR: "/pglite/dir",
    });
    expect(cfg).toEqual({ dataDir: "/pglite/dir" });
    expect(cfg).not.toHaveProperty("postgresUrl");
  });

  test("postgresql ignores pglite data dir vars", () => {
    const cfg = resolveRuntimeDatabaseAdapterConfig({
      DATABASE_ADAPTER: "postgresql",
      POSTGRES_URL: "postgres://pg",
      PGLITE_DATA_DIR: "/ignored",
    });
    expect(cfg).toEqual({ postgresUrl: "postgres://pg" });
    expect(cfg).not.toHaveProperty("dataDir");
  });
});
