import { logger } from "@elizaos/core";
import { type getTableConfig, pgSchema } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginSchema, deriveSchemaName, transformPluginSchema } from "./schema-transformer";

function pgTable(name: string, schema?: string) {
  const value = { __pgTable: true, __config: { name, schema } };
  return value as unknown as Parameters<typeof getTableConfig>[0];
}

describe("deriveSchemaName (postgres identifier safety)", () => {
  it("strips npm scope and plugin- prefix", () => {
    expect(deriveSchemaName("@elizaos/plugin-my-plugin")).toBe("my_plugin");
    expect(deriveSchemaName("@elizaos/plugin-sql")).toBe("sql");
    expect(deriveSchemaName("plugin-foo")).toBe("foo");
    expect(deriveSchemaName("@elizaos/foo")).toBe("foo");
  });

  it("lowercases and normalizes separators to single underscores", () => {
    expect(deriveSchemaName("MyPlugin")).toBe("myplugin");
    expect(deriveSchemaName("@elizaos/plugin-a.b")).toBe("a_b");
    expect(deriveSchemaName("@elizaos/plugin-a--b")).toBe("a_b");
    expect(deriveSchemaName("@elizaos/plugin-___a")).toBe("a");
    expect(deriveSchemaName("@elizaos/plugin_a__b")).toBe("plugin_a_b");
  });

  it("falls back to plugin_-prefixed names for reserved words", () => {
    expect(deriveSchemaName("public")).toBe("plugin_public");
    expect(deriveSchemaName("pg_catalog")).toBe("plugin_pg_catalog");
    expect(deriveSchemaName("information_schema")).toBe("plugin_information_schema");
    expect(deriveSchemaName("migrations")).toBe("plugin_migrations");
    expect(deriveSchemaName("PUBLIC")).toBe("plugin_public");
  });

  it("prefixes names that would start with a digit", () => {
    expect(deriveSchemaName("123abc")).toBe("p_123abc");
    expect(deriveSchemaName("9lives")).toBe("p_9lives");
  });

  it("truncates over-long identifiers to the postgres 63-char limit", () => {
    const long = `@elizaos/plugin-${"x".repeat(70)}`;
    const derived = deriveSchemaName(long);
    expect(derived.length).toBe(63);
    expect(derived.startsWith("x")).toBe(true);
  });

  it("handles degenerate and scope-only inputs without crashing", () => {
    expect(deriveSchemaName("")).toBe("plugin_");
    expect(deriveSchemaName("!!!")).toBe("plugin_");
    expect(deriveSchemaName("@elizaos/")).toBe("plugin_elizaos");
    // "plugin-" strips to nothing, so the reserved/empty fallback re-normalizes
    // the full name ("plugin") behind a plugin_ prefix.
    expect(deriveSchemaName("plugin-")).toBe("plugin_plugin");
  });
});

describe("transformPluginSchema", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns @elizaos/plugin-sql schemas untouched", () => {
    const schema = { users: pgTable("users", "public") };
    expect(transformPluginSchema("@elizaos/plugin-sql", schema)).toBe(schema);
  });

  it("warns about public-schema tables instead of rewriting them", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const schema = { users: pgTable("users", "public") };
    const transformed = transformPluginSchema("@elizaos/plugin-foo", schema) as Record<
      string,
      unknown
    >;
    expect(warn).toHaveBeenCalled();
    expect(transformed.users).toBe(schema.users);
  });

  it("leaves already-namespaced schemas unchanged without warning", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const schema = { users: pgTable("users", "foo") };
    const transformed = transformPluginSchema("@elizaos/plugin-foo", schema) as Record<
      string,
      unknown
    >;
    expect(warn).not.toHaveBeenCalled();
    expect(transformed.users).toBe(schema.users);
  });

  it("passes non-table values through untouched", () => {
    const schema = {
      plain: { some: "object" },
      str: "value",
      num: 42,
      nil: null,
    };
    const transformed = transformPluginSchema("@elizaos/plugin-foo", schema) as Record<
      string,
      unknown
    >;
    expect(transformed).toEqual(schema);
  });

  it("passes pgSchema-object values through untouched", () => {
    const schema = { scoped: pgSchema("bar") };
    const transformed = transformPluginSchema("@elizaos/plugin-foo", schema) as Record<
      string,
      unknown
    >;
    expect(transformed.scoped).toBe(schema.scoped);
  });
});

describe("createPluginSchema", () => {
  it("derives and wraps the schema name", () => {
    const created = createPluginSchema("@elizaos/plugin-foo");
    expect(created).toMatchObject({ _schema: "foo" });
    expect(typeof (created as { table?: unknown }).table).toBe("function");
  });
});
