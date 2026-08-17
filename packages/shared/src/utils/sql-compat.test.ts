/**
 * Unit tests for SQL compatibility utilities in packages/shared/src/utils/sql-compat.ts.
 * Exercises SQL identifier quoting, double-quote escaping, identifier sanitization,
 * length bounds (128 chars), SQL string literal quoting/escaping, and non-string inputs.
 */
import { describe, expect, it } from "vitest";
import { quoteIdent, sanitizeIdentifier, sqlLiteral } from "./sql-compat.js";

describe("quoteIdent", () => {
  it("quotes standard SQL identifiers with double quotes", () => {
    expect(quoteIdent("users")).toBe('"users"');
    expect(quoteIdent("created_at")).toBe('"created_at"');
  });

  it("escapes embedded double quotes by doubling them", () => {
    expect(quoteIdent('user"table')).toBe('"user""table"');
    expect(quoteIdent('a"b"c')).toBe('"a""b""c"');
  });

  it("safely handles null, undefined, or non-string inputs", () => {
    expect(quoteIdent(null)).toBe('""');
    expect(quoteIdent(undefined)).toBe('""');
    expect(quoteIdent(123 as unknown as string)).toBe('""');
  });
});

describe("sanitizeIdentifier", () => {
  it("preserves alphanumeric and underscore characters", () => {
    expect(sanitizeIdentifier("valid_table_123")).toBe("valid_table_123");
    expect(sanitizeIdentifier("CamelCase_Name")).toBe("CamelCase_Name");
  });

  it("strips invalid characters and trims whitespace", () => {
    expect(sanitizeIdentifier("  user-table.name;  ")).toBe("usertablename");
    expect(sanitizeIdentifier('col"name$')).toBe("colname");
  });

  it("returns null when empty or stripped to empty", () => {
    expect(sanitizeIdentifier("")).toBeNull();
    expect(sanitizeIdentifier("   ")).toBeNull();
    expect(sanitizeIdentifier("---;;;")).toBeNull();
  });

  it("returns null when exceeding 128 characters", () => {
    const valid128 = "a".repeat(128);
    expect(sanitizeIdentifier(valid128)).toBe(valid128);

    const invalid129 = "a".repeat(129);
    expect(sanitizeIdentifier(invalid129)).toBeNull();
  });

  it("returns null for non-string inputs", () => {
    expect(sanitizeIdentifier(null)).toBeNull();
    expect(sanitizeIdentifier(undefined)).toBeNull();
    expect(sanitizeIdentifier(456 as unknown as string)).toBeNull();
  });
});

describe("sqlLiteral", () => {
  it("wraps strings in single quotes", () => {
    expect(sqlLiteral("hello world")).toBe("'hello world'");
  });

  it("escapes embedded single quotes by doubling them", () => {
    expect(sqlLiteral("it's a test")).toBe("'it''s a test'");
    expect(sqlLiteral("O'Connor's")).toBe("'O''Connor''s'");
  });

  it("safely handles null, undefined, or non-string inputs", () => {
    expect(sqlLiteral(null)).toBe("''");
    expect(sqlLiteral(undefined)).toBe("''");
    expect(sqlLiteral(789 as unknown as string)).toBe("''");
  });
});
