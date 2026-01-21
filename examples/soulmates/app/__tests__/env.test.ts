import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isDevLoginEnabled,
  readBooleanEnv,
  readCsvEnv,
  readEnv,
} from "../lib/env";

describe("readEnv", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("basic functionality", () => {
    it("returns value when set", () => {
      process.env.TEST_VAR = "test_value";
      expect(readEnv("TEST_VAR")).toBe("test_value");
    });

    it("returns null when not set", () => {
      delete process.env.NONEXISTENT_VAR;
      expect(readEnv("NONEXISTENT_VAR")).toBeNull();
    });
  });

  describe("whitespace handling", () => {
    it("trims leading whitespace", () => {
      process.env.TEST_VAR = "   value";
      expect(readEnv("TEST_VAR")).toBe("value");
    });

    it("trims trailing whitespace", () => {
      process.env.TEST_VAR = "value   ";
      expect(readEnv("TEST_VAR")).toBe("value");
    });

    it("trims both leading and trailing whitespace", () => {
      process.env.TEST_VAR = "  value  ";
      expect(readEnv("TEST_VAR")).toBe("value");
    });

    it("trims tabs and newlines", () => {
      process.env.TEST_VAR = "\t\nvalue\n\t";
      expect(readEnv("TEST_VAR")).toBe("value");
    });
  });

  describe("empty value handling", () => {
    it("returns null for empty string", () => {
      process.env.TEST_VAR = "";
      expect(readEnv("TEST_VAR")).toBeNull();
    });

    it("returns null for whitespace-only string", () => {
      process.env.TEST_VAR = "   ";
      expect(readEnv("TEST_VAR")).toBeNull();
    });

    it("returns null for tab-only string", () => {
      process.env.TEST_VAR = "\t\t";
      expect(readEnv("TEST_VAR")).toBeNull();
    });

    it("returns null for newline-only string", () => {
      process.env.TEST_VAR = "\n\n";
      expect(readEnv("TEST_VAR")).toBeNull();
    });
  });

  describe("special characters", () => {
    it("preserves special characters", () => {
      process.env.TEST_VAR = "value=with=equals";
      expect(readEnv("TEST_VAR")).toBe("value=with=equals");
    });

    it("preserves quotes in value", () => {
      process.env.TEST_VAR = '"quoted"';
      expect(readEnv("TEST_VAR")).toBe('"quoted"');
    });

    it("preserves URLs", () => {
      process.env.TEST_VAR = "https://example.com/path?query=value";
      expect(readEnv("TEST_VAR")).toBe("https://example.com/path?query=value");
    });
  });
});

describe("readCsvEnv", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("basic functionality", () => {
    it("parses single value", () => {
      process.env.CSV_VAR = "value";
      expect(readCsvEnv("CSV_VAR")).toEqual(["value"]);
    });

    it("parses comma-separated values", () => {
      process.env.CSV_VAR = "a,b,c";
      expect(readCsvEnv("CSV_VAR")).toEqual(["a", "b", "c"]);
    });

    it("parses many values", () => {
      process.env.CSV_VAR = "a,b,c,d,e,f,g";
      expect(readCsvEnv("CSV_VAR")).toEqual([
        "a",
        "b",
        "c",
        "d",
        "e",
        "f",
        "g",
      ]);
    });
  });

  describe("whitespace handling", () => {
    it("trims each value", () => {
      process.env.CSV_VAR = "  a , b , c  ";
      expect(readCsvEnv("CSV_VAR")).toEqual(["a", "b", "c"]);
    });

    it("trims tabs and newlines in values", () => {
      process.env.CSV_VAR = "\ta\t,\nb\n,\t c \t";
      expect(readCsvEnv("CSV_VAR")).toEqual(["a", "b", "c"]);
    });
  });

  describe("empty value filtering", () => {
    it("filters empty values", () => {
      process.env.CSV_VAR = "a,,b,,c";
      expect(readCsvEnv("CSV_VAR")).toEqual(["a", "b", "c"]);
    });

    it("filters whitespace-only values", () => {
      process.env.CSV_VAR = "a,  ,b,   ,c";
      expect(readCsvEnv("CSV_VAR")).toEqual(["a", "b", "c"]);
    });

    it("handles leading comma", () => {
      process.env.CSV_VAR = ",a,b";
      expect(readCsvEnv("CSV_VAR")).toEqual(["a", "b"]);
    });

    it("handles trailing comma", () => {
      process.env.CSV_VAR = "a,b,";
      expect(readCsvEnv("CSV_VAR")).toEqual(["a", "b"]);
    });

    it("handles multiple consecutive commas", () => {
      process.env.CSV_VAR = "a,,,b";
      expect(readCsvEnv("CSV_VAR")).toEqual(["a", "b"]);
    });
  });

  describe("missing variable", () => {
    it("returns empty array when not set", () => {
      delete process.env.NONEXISTENT_VAR;
      expect(readCsvEnv("NONEXISTENT_VAR")).toEqual([]);
    });

    it("returns empty array for empty string", () => {
      process.env.CSV_VAR = "";
      expect(readCsvEnv("CSV_VAR")).toEqual([]);
    });

    it("returns empty array for whitespace-only", () => {
      process.env.CSV_VAR = "   ";
      expect(readCsvEnv("CSV_VAR")).toEqual([]);
    });
  });

  describe("special characters", () => {
    it("preserves phone numbers", () => {
      process.env.CSV_VAR = "+15551234567,+15559876543";
      expect(readCsvEnv("CSV_VAR")).toEqual(["+15551234567", "+15559876543"]);
    });

    it("preserves emails", () => {
      process.env.CSV_VAR = "a@example.com,b@example.com";
      expect(readCsvEnv("CSV_VAR")).toEqual(["a@example.com", "b@example.com"]);
    });
  });
});

describe("readBooleanEnv", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("true values", () => {
    it('returns true for "true"', () => {
      process.env.BOOL_VAR = "true";
      expect(readBooleanEnv("BOOL_VAR")).toBe(true);
    });

    it('returns true for "true" with whitespace', () => {
      process.env.BOOL_VAR = "  true  ";
      expect(readBooleanEnv("BOOL_VAR")).toBe(true);
    });
  });

  describe("false values", () => {
    it('returns false for "false"', () => {
      process.env.BOOL_VAR = "false";
      expect(readBooleanEnv("BOOL_VAR")).toBe(false);
    });

    it('returns false for "false" with whitespace', () => {
      process.env.BOOL_VAR = "  false  ";
      expect(readBooleanEnv("BOOL_VAR")).toBe(false);
    });
  });

  describe("other string values", () => {
    it('returns false for "0"', () => {
      process.env.BOOL_VAR = "0";
      expect(readBooleanEnv("BOOL_VAR")).toBe(false);
    });

    it('returns false for "1"', () => {
      process.env.BOOL_VAR = "1";
      expect(readBooleanEnv("BOOL_VAR")).toBe(false);
    });

    it('returns false for "yes"', () => {
      process.env.BOOL_VAR = "yes";
      expect(readBooleanEnv("BOOL_VAR")).toBe(false);
    });

    it('returns false for "TRUE" (case sensitive)', () => {
      process.env.BOOL_VAR = "TRUE";
      expect(readBooleanEnv("BOOL_VAR")).toBe(false);
    });
  });

  describe("fallback values", () => {
    it("returns false fallback when not set (default)", () => {
      delete process.env.NONEXISTENT_VAR;
      expect(readBooleanEnv("NONEXISTENT_VAR")).toBe(false);
    });

    it("returns true fallback when specified and not set", () => {
      delete process.env.NONEXISTENT_VAR;
      expect(readBooleanEnv("NONEXISTENT_VAR", true)).toBe(true);
    });

    it("returns false fallback when specified and not set", () => {
      delete process.env.NONEXISTENT_VAR;
      expect(readBooleanEnv("NONEXISTENT_VAR", false)).toBe(false);
    });

    it("ignores fallback when value is set", () => {
      process.env.BOOL_VAR = "true";
      expect(readBooleanEnv("BOOL_VAR", false)).toBe(true);
    });
  });
});

describe("isDevLoginEnabled", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("explicit values", () => {
    it("returns true when explicitly enabled", () => {
      process.env.DEV_LOGIN_ENABLED = "true";
      expect(isDevLoginEnabled()).toBe(true);
    });

    it("returns false when explicitly disabled", () => {
      process.env.DEV_LOGIN_ENABLED = "false";
      expect(isDevLoginEnabled()).toBe(false);
    });
  });

  describe("NODE_ENV fallback", () => {
    it("returns true in development mode by default", () => {
      delete process.env.DEV_LOGIN_ENABLED;
      (process.env as Record<string, string | undefined>).NODE_ENV =
        "development";
      expect(isDevLoginEnabled()).toBe(true);
    });

    it("returns false in production mode by default", () => {
      delete process.env.DEV_LOGIN_ENABLED;
      (process.env as Record<string, string | undefined>).NODE_ENV =
        "production";
      expect(isDevLoginEnabled()).toBe(false);
    });

    it("returns false in test mode by default", () => {
      delete process.env.DEV_LOGIN_ENABLED;
      (process.env as Record<string, string | undefined>).NODE_ENV = "test";
      expect(isDevLoginEnabled()).toBe(false);
    });

    it("explicit value overrides NODE_ENV", () => {
      process.env.DEV_LOGIN_ENABLED = "false";
      (process.env as Record<string, string | undefined>).NODE_ENV =
        "development";
      expect(isDevLoginEnabled()).toBe(false);
    });
  });
});
