import { describe, expect, test } from "bun:test";
import {
  getRuntimeDatabaseBackend,
  resolveRuntimeDatabaseAdapterConfig,
} from "@/lib/eliza/database-adapter-config";

describe("runtime database adapter config", () => {
  test("defaults to PostgreSQL with DATABASE_URL", () => {
    const env = {
      DATABASE_URL: "postgresql://app:pass@localhost:5432/app",
    };

    expect(getRuntimeDatabaseBackend(env)).toBe("postgresql");
    expect(resolveRuntimeDatabaseAdapterConfig(env)).toEqual({
      postgresUrl: "postgresql://app:pass@localhost:5432/app",
    });
  });

  test("prefers POSTGRES_URL for the Eliza runtime adapter", () => {
    expect(
      resolveRuntimeDatabaseAdapterConfig({
        DATABASE_URL: "postgresql://platform",
        POSTGRES_URL: "postgresql://runtime",
      }),
    ).toEqual({ postgresUrl: "postgresql://runtime" });
  });

  test("maps pglite mode to file-backed PGlite", () => {
    const env = {
      DATABASE_ENGINE: "pglite",
      PGLITE_DATA_DIR: ".tmp/eliza-pglite",
    };

    expect(getRuntimeDatabaseBackend(env)).toBe("pglite");
    expect(resolveRuntimeDatabaseAdapterConfig(env)).toEqual({
      dataDir: ".tmp/eliza-pglite",
    });
  });

  test("treats legacy sqlite alias as pglite for backwards-compat", () => {
    expect(getRuntimeDatabaseBackend({ DATABASE_ENGINE: "sqlite" })).toBe("pglite");
  });

  test("rejects unknown database engines", () => {
    expect(() => resolveRuntimeDatabaseAdapterConfig({ DATABASE_DIALECT: "mysql" })).toThrow(
      /Unsupported DATABASE_ENGINE/,
    );
  });
});
