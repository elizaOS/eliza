/**
 * Verifies Electrobun database-mode resolution, credential redaction, and
 * child-env application against the real resolver with deterministic inputs.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyDatabaseResolutionToEnv,
  type DatabaseModeResolution,
  type DatabaseModeResolverOptions,
  redactDatabaseTarget,
  resolveDatabaseMode,
} from "../database-mode.ts";

function options(
  overrides: Partial<DatabaseModeResolverOptions> = {},
): DatabaseModeResolverOptions {
  return {
    env: {},
    packagedDesktop: false,
    appStateDir: "/tmp/app-state",
    ...overrides,
  };
}

describe("redactDatabaseTarget", () => {
  it("returns null for missing, empty, and whitespace-only values", () => {
    expect(redactDatabaseTarget(undefined)).toBeNull();
    expect(redactDatabaseTarget("")).toBeNull();
    expect(redactDatabaseTarget("   ")).toBeNull();
  });

  it("redacts username and password on a parseable URL", () => {
    expect(
      redactDatabaseTarget("postgres://user:secret@localhost:5432/eliza"),
    ).toBe("postgres://%5Buser%5D:%5Bpassword%5D@localhost:5432/eliza");
  });

  it("redacts only the username when the URL has no password", () => {
    expect(redactDatabaseTarget("postgres://owner@localhost/eliza")).toBe(
      "postgres://%5Buser%5D@localhost/eliza",
    );
  });

  it("leaves parseable URLs without credentials unchanged", () => {
    expect(redactDatabaseTarget("postgres://localhost:5432/eliza")).toBe(
      "postgres://localhost:5432/eliza",
    );
  });

  it("trims input before parsing", () => {
    expect(redactDatabaseTarget("  postgres://localhost:5432/eliza  ")).toBe(
      "postgres://localhost:5432/eliza",
    );
  });

  it("falls back to regex redaction when URL parsing fails", () => {
    expect(redactDatabaseTarget("not a url://alice:bob@host/db")).toBe(
      "not a url://[user]:[password]@host/db",
    );
  });

  it("returns the trimmed string when parsing fails and no userinfo is present", () => {
    expect(redactDatabaseTarget("  not-a-url  ")).toBe("not-a-url");
  });
});

describe("resolveDatabaseMode", () => {
  it("selects POSTGRES_URL over every other source", () => {
    const result = resolveDatabaseMode(
      options({
        env: {
          POSTGRES_URL: "  postgres://user:secret@localhost:5432/eliza  ",
          DATABASE_URL: "postgres://other:secret@localhost:5432/other",
          ELIZA_DB_MODE: "memory",
          PGLITE_DATA_DIR: "/tmp/ignored",
        },
        packagedDesktop: true,
      }),
    );

    expect(result).toEqual({
      mode: "postgres",
      postgresUrl: "postgres://user:secret@localhost:5432/eliza",
      source: "POSTGRES_URL",
      warnings: [],
      databaseUrlMapped: false,
    });
  });

  it("treats whitespace-only POSTGRES_URL as absent", () => {
    const result = resolveDatabaseMode(
      options({
        env: {
          POSTGRES_URL: "   ",
          DATABASE_URL: "postgres://user:secret@localhost:5432/eliza",
        },
      }),
    );

    expect(result.source).toBe("DATABASE_URL");
    expect(result.postgresUrl).toBe(
      "postgres://user:secret@localhost:5432/eliza",
    );
    expect(result.databaseUrlMapped).toBe(true);
  });

  it("maps DATABASE_URL to postgres with a warning", () => {
    const result = resolveDatabaseMode(
      options({
        env: {
          DATABASE_URL: " postgres://mapped:secret@localhost:5432/eliza ",
          ELIZA_DB_MODE: "memory",
          PGLITE_DATA_DIR: "/tmp/ignored",
        },
        packagedDesktop: true,
      }),
    );

    expect(result.mode).toBe("postgres");
    expect(result.source).toBe("DATABASE_URL");
    expect(result.postgresUrl).toBe(
      "postgres://mapped:secret@localhost:5432/eliza",
    );
    expect(result.databaseUrlMapped).toBe(true);
    expect(result.warnings).toEqual([
      "DATABASE_URL is mapped to POSTGRES_URL for the agent runtime.",
    ]);
  });

  it("uses explicit memory mode for memory and pglite-memory, case-insensitively", () => {
    for (const value of [
      "memory",
      "MEMORY",
      " pglite-memory ",
      "PGLITE-MEMORY",
    ]) {
      const result = resolveDatabaseMode(
        options({
          env: { ELIZA_DB_MODE: value, PGLITE_DATA_DIR: "/tmp/ignored" },
          packagedDesktop: true,
        }),
      );
      expect(result).toEqual({
        mode: "pglite-memory",
        pgliteDataDir: "memory://",
        source: "explicit-memory",
        warnings: [],
        databaseUrlMapped: false,
      });
    }
  });

  it("does not treat other ELIZA_DB_MODE values as explicit memory", () => {
    const result = resolveDatabaseMode(
      options({
        env: { ELIZA_DB_MODE: "pglite", PGLITE_DATA_DIR: "/abs/db" },
      }),
    );

    expect(result.mode).toBe("pglite-persistent");
    expect(result.source).toBe("PGLITE_DATA_DIR");
  });

  it("resolves a persistent PGLITE_DATA_DIR relative to cwd", () => {
    const result = resolveDatabaseMode(
      options({
        env: { PGLITE_DATA_DIR: "  data/pglite  " },
        cwd: "/tmp/project",
      }),
    );

    expect(result).toEqual({
      mode: "pglite-persistent",
      pgliteDataDir: path.resolve("/tmp/project", "data/pglite"),
      source: "PGLITE_DATA_DIR",
      warnings: [],
      databaseUrlMapped: false,
    });
  });

  it("keeps an absolute persistent PGLITE_DATA_DIR", () => {
    const result = resolveDatabaseMode(
      options({ env: { PGLITE_DATA_DIR: "/abs/db" } }),
    );

    expect(result.mode).toBe("pglite-persistent");
    expect(result.pgliteDataDir).toBe("/abs/db");
    expect(result.source).toBe("PGLITE_DATA_DIR");
  });

  it("maps a memory:// PGLITE_DATA_DIR to pglite-memory", () => {
    const result = resolveDatabaseMode(
      options({
        env: { PGLITE_DATA_DIR: "  memory://  " },
        packagedDesktop: true,
      }),
    );

    expect(result).toEqual({
      mode: "pglite-memory",
      pgliteDataDir: "memory://",
      source: "PGLITE_DATA_DIR",
      warnings: [],
      databaseUrlMapped: false,
    });
  });

  it("treats MEMORY:// as a filesystem path because the sentinel is case-sensitive", () => {
    const result = resolveDatabaseMode(
      options({
        env: { PGLITE_DATA_DIR: "MEMORY://" },
        cwd: "/tmp/project",
      }),
    );

    expect(result.mode).toBe("pglite-persistent");
    expect(result.pgliteDataDir).toBe(
      path.resolve("/tmp/project", "MEMORY://"),
    );
    expect(result.source).toBe("PGLITE_DATA_DIR");
  });

  it("uses the packaged-desktop default when no env source is set", () => {
    const appStateDir = "/Users/example/Library/Application Support/Eliza";
    const result = resolveDatabaseMode(
      options({ packagedDesktop: true, appStateDir }),
    );

    expect(result).toEqual({
      mode: "pglite-persistent",
      pgliteDataDir: path.join(appStateDir, "database", "pglite"),
      source: "packaged-desktop-default",
      warnings: [],
      databaseUrlMapped: false,
    });
  });

  it("returns unknown with a development-policy warning when unpackaged and unset", () => {
    const result = resolveDatabaseMode(options());

    expect(result).toEqual({
      mode: "unknown",
      source: "unknown",
      warnings: [
        "No desktop database env was set; the child runtime will use its development database policy.",
      ],
      databaseUrlMapped: false,
    });
    expect(result.postgresUrl).toBeUndefined();
    expect(result.pgliteDataDir).toBeUndefined();
  });

  it("resolves a relative PGLITE_DATA_DIR against process.cwd when cwd is omitted", () => {
    const result = resolveDatabaseMode(
      options({ env: { PGLITE_DATA_DIR: "rel/db" } }),
    );

    expect(result.mode).toBe("pglite-persistent");
    expect(result.pgliteDataDir).toBe(path.resolve(process.cwd(), "rel/db"));
  });
});

describe("applyDatabaseResolutionToEnv", () => {
  it("writes POSTGRES_URL and removes PGLITE_DATA_DIR for postgres mode", () => {
    const childEnv: Record<string, string> = {
      PGLITE_DATA_DIR: "/tmp/old",
      DATABASE_URL: "postgres://keep-me",
    };
    const resolution: DatabaseModeResolution = {
      mode: "postgres",
      postgresUrl: "postgres://user:secret@localhost:5432/eliza",
      source: "POSTGRES_URL",
      warnings: [],
      databaseUrlMapped: false,
    };

    applyDatabaseResolutionToEnv(childEnv, resolution);

    expect(childEnv.POSTGRES_URL).toBe(
      "postgres://user:secret@localhost:5432/eliza",
    );
    expect(childEnv.PGLITE_DATA_DIR).toBeUndefined();
    expect(childEnv.DATABASE_URL).toBe("postgres://keep-me");
  });

  it("writes PGLITE_DATA_DIR and removes POSTGRES_URL for persistent pglite", () => {
    const childEnv: Record<string, string> = {
      POSTGRES_URL: "postgres://old",
    };
    const resolution: DatabaseModeResolution = {
      mode: "pglite-persistent",
      pgliteDataDir: "/state/database/pglite",
      source: "packaged-desktop-default",
      warnings: [],
      databaseUrlMapped: false,
    };

    applyDatabaseResolutionToEnv(childEnv, resolution);

    expect(childEnv.PGLITE_DATA_DIR).toBe("/state/database/pglite");
    expect(childEnv.POSTGRES_URL).toBeUndefined();
  });

  it("writes the memory sentinel for pglite-memory mode", () => {
    const childEnv: Record<string, string> = {
      POSTGRES_URL: "postgres://old",
    };
    const resolution: DatabaseModeResolution = {
      mode: "pglite-memory",
      pgliteDataDir: "memory://",
      source: "explicit-memory",
      warnings: [],
      databaseUrlMapped: false,
    };

    applyDatabaseResolutionToEnv(childEnv, resolution);

    expect(childEnv.PGLITE_DATA_DIR).toBe("memory://");
    expect(childEnv.POSTGRES_URL).toBeUndefined();
  });

  it("leaves the child env unchanged for unknown mode", () => {
    const childEnv: Record<string, string> = {
      POSTGRES_URL: "postgres://keep",
      PGLITE_DATA_DIR: "/tmp/keep",
    };

    applyDatabaseResolutionToEnv(childEnv, {
      mode: "unknown",
      source: "unknown",
      warnings: [
        "No desktop database env was set; the child runtime will use its development database policy.",
      ],
      databaseUrlMapped: false,
    });

    expect(childEnv).toEqual({
      POSTGRES_URL: "postgres://keep",
      PGLITE_DATA_DIR: "/tmp/keep",
    });
  });

  it("does not mutate env when postgres mode is missing a url", () => {
    const childEnv: Record<string, string> = {
      PGLITE_DATA_DIR: "/tmp/old",
    };

    applyDatabaseResolutionToEnv(childEnv, {
      mode: "postgres",
      source: "POSTGRES_URL",
      warnings: [],
      databaseUrlMapped: false,
    });

    expect(childEnv).toEqual({ PGLITE_DATA_DIR: "/tmp/old" });
  });

  it("does not mutate env when pglite mode is missing a data dir", () => {
    const childEnv: Record<string, string> = {
      POSTGRES_URL: "postgres://keep",
    };

    applyDatabaseResolutionToEnv(childEnv, {
      mode: "pglite-persistent",
      source: "PGLITE_DATA_DIR",
      warnings: [],
      databaseUrlMapped: false,
    });

    expect(childEnv).toEqual({ POSTGRES_URL: "postgres://keep" });
  });
});
