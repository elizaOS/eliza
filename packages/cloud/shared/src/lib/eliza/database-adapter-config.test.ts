/**
 * Coverage for database-adapter-config.
 */
import { describe, expect, it } from "vitest";
import {
  getRuntimeDatabaseBackend,
  resolveRuntimeDatabaseAdapterConfig,
} from "./database-adapter-config.js";

describe("database-adapter-config", () => {
  it("resolves backend", () => {
    expect(getRuntimeDatabaseBackend({ DATABASE_ENGINE: "pglite" })).toBe("pglite");
    expect(getRuntimeDatabaseBackend({ DATABASE_ENGINE: "postgresql" })).toBe("postgresql");
    expect(getRuntimeDatabaseBackend({ DATABASE_ENGINE: "postgres" })).toBe("postgresql");
    expect(getRuntimeDatabaseBackend({})).toBe("postgresql");
  });
  it("throws on unsupported", () => {
    expect(() => getRuntimeDatabaseBackend({ DATABASE_ENGINE: "bad" })).toThrow();
  });
  it("resolves pglite config", () => {
    const c = resolveRuntimeDatabaseAdapterConfig({ DATABASE_ENGINE: "pglite" });
    expect(c.dataDir).toBeTruthy();
  });
  it("throws without postgres url", () => {
    expect(() => resolveRuntimeDatabaseAdapterConfig({ DATABASE_ENGINE: "postgresql" })).toThrow();
  });
});
