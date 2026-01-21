import { describe, expect, it } from "vitest";
import {
  normalizeEmail,
  validateEmail,
  validateLocation,
  validateName,
  validateProfileUpdate,
} from "../lib/validation";

describe("validateEmail", () => {
  describe("valid emails", () => {
    it("accepts standard email formats", () => {
      expect(validateEmail("test@example.com")).toBeNull();
      expect(validateEmail("user@domain.org")).toBeNull();
      expect(validateEmail("admin@company.co.uk")).toBeNull();
    });

    it("accepts emails with special characters in local part", () => {
      expect(validateEmail("user.name@example.com")).toBeNull();
      expect(validateEmail("user+tag@example.com")).toBeNull();
      expect(validateEmail("user_name@example.com")).toBeNull();
      expect(validateEmail("user-name@example.com")).toBeNull();
      expect(validateEmail("user!name@example.com")).toBeNull();
      expect(validateEmail("user#name@example.com")).toBeNull();
      expect(validateEmail("user$name@example.com")).toBeNull();
      expect(validateEmail("user%name@example.com")).toBeNull();
      expect(validateEmail("user&name@example.com")).toBeNull();
      expect(validateEmail("user'name@example.com")).toBeNull();
      expect(validateEmail("user*name@example.com")).toBeNull();
      expect(validateEmail("user=name@example.com")).toBeNull();
      expect(validateEmail("user?name@example.com")).toBeNull();
      expect(validateEmail("user^name@example.com")).toBeNull();
      expect(validateEmail("user`name@example.com")).toBeNull();
      expect(validateEmail("user{name}@example.com")).toBeNull();
      expect(validateEmail("user|name@example.com")).toBeNull();
      expect(validateEmail("user~name@example.com")).toBeNull();
    });

    it("accepts emails with subdomains", () => {
      expect(validateEmail("user@mail.example.com")).toBeNull();
      expect(validateEmail("user@a.b.c.example.com")).toBeNull();
    });

    it("accepts emails with numeric domains", () => {
      expect(validateEmail("user@123.com")).toBeNull();
    });

    it("accepts short valid emails", () => {
      expect(validateEmail("a@b.co")).toBeNull();
      expect(validateEmail("x@y.io")).toBeNull();
    });
  });

  describe("optional field (empty allowed)", () => {
    it("accepts empty string", () => {
      expect(validateEmail("")).toBeNull();
    });

    it("accepts whitespace-only", () => {
      expect(validateEmail("   ")).toBeNull();
      expect(validateEmail("\t\n")).toBeNull();
    });
  });

  describe("invalid emails", () => {
    it("rejects emails without @", () => {
      expect(validateEmail("userexample.com")).not.toBeNull();
    });

    it("rejects emails without local part", () => {
      expect(validateEmail("@example.com")).not.toBeNull();
    });

    it("rejects emails without domain", () => {
      expect(validateEmail("user@")).not.toBeNull();
    });

    it("rejects emails without TLD", () => {
      const error = validateEmail("user@domain");
      expect(error).not.toBeNull();
      expect(error).toContain("TLD");
    });

    it("rejects emails with consecutive dots", () => {
      const error = validateEmail("user..name@example.com");
      expect(error).not.toBeNull();
      expect(error).toContain("consecutive dots");
    });

    it("rejects emails with spaces", () => {
      expect(validateEmail("user name@example.com")).not.toBeNull();
      expect(validateEmail("user@exam ple.com")).not.toBeNull();
    });

    it("rejects emails with invalid characters", () => {
      expect(validateEmail("user<name>@example.com")).not.toBeNull();
      expect(validateEmail("user[name]@example.com")).not.toBeNull();
    });
  });

  describe("length validation", () => {
    it("rejects emails longer than 254 characters", () => {
      const longEmail = `${"a".repeat(250)}@b.co`;
      const error = validateEmail(longEmail);
      expect(error).not.toBeNull();
      expect(error).toContain("254");
    });

    it("rejects local part longer than 64 characters", () => {
      const longLocal = `${"a".repeat(65)}@example.com`;
      const error = validateEmail(longLocal);
      expect(error).not.toBeNull();
      expect(error).toContain("64");
    });

    it("rejects domain longer than 253 characters", () => {
      const longDomain = `user@${"a".repeat(250)}.com`;
      const error = validateEmail(longDomain);
      expect(error).not.toBeNull();
      // Overall email length (254) check triggers before domain-specific check
      expect(error).toMatch(/254|253/);
    });

    it("accepts emails at exact length limits", () => {
      // 64 char local + @ + domain
      const exactLocal = `${"a".repeat(64)}@example.com`;
      expect(validateEmail(exactLocal)).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("handles null gracefully", () => {
      expect(validateEmail(null as unknown as string)).toBeNull();
    });

    it("handles undefined gracefully", () => {
      expect(validateEmail(undefined as unknown as string)).toBeNull();
    });

    it("trims whitespace before validation", () => {
      expect(validateEmail("  test@example.com  ")).toBeNull();
    });

    it("rejects email with only dots in local part", () => {
      expect(validateEmail("...@example.com")).not.toBeNull();
    });
  });
});

describe("normalizeEmail", () => {
  it("lowercases email", () => {
    expect(normalizeEmail("Test@Example.COM")).toBe("test@example.com");
    expect(normalizeEmail("USER@DOMAIN.ORG")).toBe("user@domain.org");
  });

  it("trims whitespace", () => {
    expect(normalizeEmail("  test@example.com  ")).toBe("test@example.com");
    expect(normalizeEmail("\tuser@domain.org\n")).toBe("user@domain.org");
  });

  it("returns null for empty input", () => {
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail("   ")).toBeNull();
  });

  it("handles null and undefined", () => {
    expect(normalizeEmail(null as unknown as string)).toBeNull();
    expect(normalizeEmail(undefined as unknown as string)).toBeNull();
  });

  it("preserves special characters", () => {
    expect(normalizeEmail("User+Tag@Example.com")).toBe("user+tag@example.com");
    expect(normalizeEmail("First.Last@Example.com")).toBe(
      "first.last@example.com",
    );
  });
});

describe("validateName", () => {
  describe("valid names", () => {
    it("accepts standard names", () => {
      expect(validateName("John Doe")).toBeNull();
      expect(validateName("Jane Smith")).toBeNull();
    });

    it("accepts names with apostrophes", () => {
      expect(validateName("O'Brien")).toBeNull();
      expect(validateName("O'Connor")).toBeNull();
    });

    it("accepts names with hyphens", () => {
      expect(validateName("Mary-Jane")).toBeNull();
      expect(validateName("Jean-Pierre")).toBeNull();
    });

    it("accepts names with accented characters", () => {
      expect(validateName("María García")).toBeNull();
      expect(validateName("François")).toBeNull();
      expect(validateName("Müller")).toBeNull();
      expect(validateName("北京")).toBeNull();
    });

    it("accepts single word names", () => {
      expect(validateName("Madonna")).toBeNull();
      expect(validateName("Prince")).toBeNull();
    });

    it("accepts names with numbers", () => {
      expect(validateName("John Smith III")).toBeNull();
      expect(validateName("Agent 47")).toBeNull();
    });
  });

  describe("optional field (empty allowed)", () => {
    it("accepts empty string", () => {
      expect(validateName("")).toBeNull();
    });

    it("accepts whitespace-only (treated as empty)", () => {
      expect(validateName("   ")).toBeNull();
    });
  });

  describe("invalid names", () => {
    it("rejects names with angle brackets", () => {
      const error = validateName("<script>");
      expect(error).not.toBeNull();
      expect(error).toContain("invalid characters");
    });

    it("rejects names with curly braces", () => {
      expect(validateName("Name{test}")).not.toBeNull();
    });

    it("rejects names with square brackets", () => {
      expect(validateName("Name[test]")).not.toBeNull();
    });

    it("rejects names with backslashes", () => {
      expect(validateName("Name\\test")).not.toBeNull();
    });
  });

  describe("length validation", () => {
    it("rejects names longer than 255 characters", () => {
      const longName = "a".repeat(256);
      const error = validateName(longName);
      expect(error).not.toBeNull();
      expect(error).toContain("255");
    });

    it("accepts names at exactly 255 characters", () => {
      const exactName = "a".repeat(255);
      expect(validateName(exactName)).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("handles null gracefully", () => {
      expect(validateName(null as unknown as string)).toBeNull();
    });

    it("handles undefined gracefully", () => {
      expect(validateName(undefined as unknown as string)).toBeNull();
    });

    it("trims whitespace before validation", () => {
      expect(validateName("  John Doe  ")).toBeNull();
    });
  });
});

describe("validateLocation", () => {
  describe("valid locations", () => {
    it("accepts city names", () => {
      expect(validateLocation("New York")).toBeNull();
      expect(validateLocation("San Francisco")).toBeNull();
    });

    it("accepts city and state", () => {
      expect(validateLocation("New York, NY")).toBeNull();
      expect(validateLocation("Los Angeles, CA")).toBeNull();
    });

    it("accepts city and country", () => {
      expect(validateLocation("London, UK")).toBeNull();
      expect(validateLocation("Paris, France")).toBeNull();
    });

    it("accepts international characters", () => {
      expect(validateLocation("東京")).toBeNull();
      expect(validateLocation("São Paulo")).toBeNull();
    });

    it("accepts locations with special characters", () => {
      expect(validateLocation("St. Louis")).toBeNull();
      expect(validateLocation("Winston-Salem")).toBeNull();
    });
  });

  describe("optional field (empty allowed)", () => {
    it("accepts empty string", () => {
      expect(validateLocation("")).toBeNull();
    });

    it("accepts whitespace-only", () => {
      expect(validateLocation("   ")).toBeNull();
    });
  });

  describe("length validation", () => {
    it("rejects locations longer than 255 characters", () => {
      const longLocation = "a".repeat(256);
      const error = validateLocation(longLocation);
      expect(error).not.toBeNull();
      expect(error).toContain("255");
    });

    it("accepts locations at exactly 255 characters", () => {
      const exactLocation = "a".repeat(255);
      expect(validateLocation(exactLocation)).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("handles null gracefully", () => {
      expect(validateLocation(null as unknown as string)).toBeNull();
    });

    it("handles undefined gracefully", () => {
      expect(validateLocation(undefined as unknown as string)).toBeNull();
    });
  });
});

describe("validateProfileUpdate", () => {
  describe("valid updates", () => {
    it("validates complete valid input", () => {
      const result = validateProfileUpdate({
        name: "John Doe",
        email: "john@example.com",
        location: "New York, NY",
      });
      expect(result.valid).toBe(true);
      expect(Object.keys(result.errors)).toHaveLength(0);
    });

    it("validates partial updates", () => {
      expect(validateProfileUpdate({ name: "John" }).valid).toBe(true);
      expect(validateProfileUpdate({ email: "john@example.com" }).valid).toBe(
        true,
      );
      expect(validateProfileUpdate({ location: "NYC" }).valid).toBe(true);
    });

    it("validates empty object", () => {
      const result = validateProfileUpdate({});
      expect(result.valid).toBe(true);
    });
  });

  describe("null and undefined values", () => {
    it("accepts null values (skip validation)", () => {
      const result = validateProfileUpdate({
        name: null,
        email: null,
        location: null,
      });
      expect(result.valid).toBe(true);
    });

    it("accepts undefined values (skip validation)", () => {
      const result = validateProfileUpdate({
        name: undefined,
        email: undefined,
        location: undefined,
      });
      expect(result.valid).toBe(true);
    });

    it("mixes null, undefined, and valid values", () => {
      const result = validateProfileUpdate({
        name: "John",
        email: null,
        location: undefined,
      });
      expect(result.valid).toBe(true);
    });
  });

  describe("invalid updates", () => {
    it("collects all errors", () => {
      const result = validateProfileUpdate({
        name: "<invalid>",
        email: "notanemail",
        location: "a".repeat(256),
      });
      expect(result.valid).toBe(false);
      expect(result.errors.name).toBeDefined();
      expect(result.errors.email).toBeDefined();
      expect(result.errors.location).toBeDefined();
    });

    it("reports single field error", () => {
      const result = validateProfileUpdate({
        name: "Valid Name",
        email: "invalid",
        location: "Valid Location",
      });
      expect(result.valid).toBe(false);
      expect(result.errors.email).toBeDefined();
      expect(result.errors.name).toBeUndefined();
      expect(result.errors.location).toBeUndefined();
    });

    it("validates name errors correctly", () => {
      const result = validateProfileUpdate({ name: "<script>" });
      expect(result.valid).toBe(false);
      expect(result.errors.name).toContain("invalid characters");
    });

    it("validates email errors correctly", () => {
      const result = validateProfileUpdate({ email: "invalid" });
      expect(result.valid).toBe(false);
    });

    it("validates location errors correctly", () => {
      const result = validateProfileUpdate({ location: "a".repeat(256) });
      expect(result.valid).toBe(false);
      expect(result.errors.location).toContain("255");
    });
  });

  describe("boundary conditions", () => {
    it("handles max length inputs", () => {
      // Domain labels limited to 63 chars by regex
      // Using valid email with long but valid domain
      const result = validateProfileUpdate({
        name: "a".repeat(255),
        email: `user@${"a".repeat(61)}.example.com`,
        location: "a".repeat(255),
      });
      expect(result.valid).toBe(true);
    });

    it("rejects inputs just over max length", () => {
      const result = validateProfileUpdate({
        name: "a".repeat(256),
      });
      expect(result.valid).toBe(false);
      expect(result.errors.name).toBeDefined();
    });
  });
});
