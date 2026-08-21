/**
 * Unit tests for SQL compatibility utilities in packages/shared/src/utils/sql-compat.ts.
 * Exercises identifier quoting and escaping, identifier sanitization with character/length limits,
 * and string literal quoting with single-quote escaping.
 */
import { describe, expect, it } from "vitest";
import { quoteIdent, sanitizeIdentifier, sqlLiteral } from "./sql-compat.js";

describe("sql-compat utilities", () => {
  describe("quoteIdent", () => {
    it("quotes standard SQL identifiers with double quotes", () => {
      expect(quoteIdent("users")).toBe('"users"');
      expect(quoteIdent("created_at")).toBe('"created_at"');
      expect(quoteIdent("AgentRuntime")).toBe('"AgentRuntime"');
    });

    it("escapes embedded double quotes by doubling them", () => {
      expect(quoteIdent('user"name')).toBe('"user""name"');
      expect(quoteIdent('a"b"c')).toBe('"a""b""c"');
      expect(quoteIdent('"""')).toBe('""""""""');
    });

    it("quotes empty string as empty double-quoted identifier", () => {
      expect(quoteIdent("")).toBe('""');
    });
  });

  describe("sanitizeIdentifier", () => {
    it("preserves alphanumeric and underscore characters", () => {
      expect(sanitizeIdentifier("users")).toBe("users");
      expect(sanitizeIdentifier("agent_memories_v2")).toBe("agent_memories_v2");
      expect(sanitizeIdentifier("Room123")).toBe("Room123");
    });

    it("strips invalid characters and trims whitespace", () => {
      expect(sanitizeIdentifier("  my-table!  ")).toBe("mytable");
      expect(sanitizeIdentifier("users; DROP TABLE users;--")).toBe(
        "usersDROPTABLEusers",
      );
      expect(sanitizeIdentifier("column.name")).toBe("columnname");
    });

    it("returns null when empty or stripped to empty", () => {
      expect(sanitizeIdentifier("")).toBeNull();
      expect(sanitizeIdentifier("   ")).toBeNull();
      expect(sanitizeIdentifier("!@#$%^&*()-+")).toBeNull();
    });

    it("returns null when exceeding 128 characters", () => {
      const validLong = "a".repeat(128);
      expect(sanitizeIdentifier(validLong)).toBe(validLong);

      const tooLong = "a".repeat(129);
      expect(sanitizeIdentifier(tooLong)).toBeNull();
    });

    it("returns null for nullish inputs", () => {
      expect(sanitizeIdentifier(null)).toBeNull();
      expect(sanitizeIdentifier(undefined)).toBeNull();
    });
  });

  describe("sqlLiteral", () => {
    it("wraps strings in single quotes", () => {
      expect(sqlLiteral("hello")).toBe("'hello'");
      expect(sqlLiteral("public")).toBe("'public'");
      expect(sqlLiteral("12345")).toBe("'12345'");
    });

    it("escapes embedded single quotes by doubling them", () => {
      expect(sqlLiteral("it's")).toBe("'it''s'");
      expect(sqlLiteral("O'Connor's")).toBe("'O''Connor''s'");
      expect(sqlLiteral("'''")).toBe("''''''''");
    });

    it("wraps empty string in single quotes", () => {
      expect(sqlLiteral("")).toBe("''");
    });
  });
});
