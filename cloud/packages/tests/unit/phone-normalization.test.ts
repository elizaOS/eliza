/**
 * Phone Normalization Utility Tests
 *
 * Tests for phone number normalization and validation utilities.
 */

import { describe, expect, it } from "bun:test";
import {
  isValidE164,
  isValidEmail,
  normalizePhoneNumber,
  normalizeToE164,
  parsePhoneNumber,
  validatePhoneForAPI,
} from "@/lib/utils/phone-normalization";

describe("Phone Normalization Utilities", () => {
  describe("isValidE164", () => {
    it("validates correct E.164 format", () => {
      expect(isValidE164("+14155552671")).toBe(true);
      expect(isValidE164("+442071838750")).toBe(true);
      expect(isValidE164("+12025551234")).toBe(true);
    });

    it("rejects numbers without plus sign", () => {
      expect(isValidE164("14155552671")).toBe(false);
      expect(isValidE164("442071838750")).toBe(false);
    });

    it("rejects numbers with invalid formats", () => {
      expect(isValidE164("+0155552671")).toBe(false); // Cannot start with 0 after +
      expect(isValidE164("+1")).toBe(false); // Too short
      expect(isValidE164("+12345678901234567")).toBe(false); // Too long (> 15 digits)
      expect(isValidE164("")).toBe(false);
      expect(isValidE164("+")).toBe(false);
    });

    it("rejects numbers with non-digit characters", () => {
      expect(isValidE164("+1-415-555-2671")).toBe(false);
      expect(isValidE164("+1 (415) 555-2671")).toBe(false);
      expect(isValidE164("+1.415.555.2671")).toBe(false);
    });
  });

  describe("isValidEmail", () => {
    it("validates correct email formats", () => {
      expect(isValidEmail("user@example.com")).toBe(true);
      expect(isValidEmail("user.name@example.com")).toBe(true);
      expect(isValidEmail("user+tag@example.co.uk")).toBe(true);
    });

    it("rejects invalid email formats", () => {
      expect(isValidEmail("user@")).toBe(false);
      expect(isValidEmail("@example.com")).toBe(false);
      expect(isValidEmail("user example.com")).toBe(false);
      expect(isValidEmail("")).toBe(false);
    });
  });

  describe("normalizeToE164", () => {
    it("normalizes 10-digit US numbers", () => {
      expect(normalizeToE164("4155552671")).toBe("+14155552671");
      expect(normalizeToE164("(415) 555-2671")).toBe("+14155552671");
      expect(normalizeToE164("415-555-2671")).toBe("+14155552671");
      expect(normalizeToE164("415.555.2671")).toBe("+14155552671");
    });

    it("normalizes 11-digit numbers starting with 1", () => {
      expect(normalizeToE164("14155552671")).toBe("+14155552671");
      expect(normalizeToE164("1-415-555-2671")).toBe("+14155552671");
    });

    it("validates existing E.164 numbers", () => {
      expect(normalizeToE164("+14155552671")).toBe("+14155552671");
      expect(normalizeToE164("+442071838750")).toBe("+442071838750");
    });

    it("returns null for invalid formats", () => {
      expect(normalizeToE164("12345")).toBe(null); // Too short
      expect(normalizeToE164("123456789012345678")).toBe(null); // Too long
      expect(normalizeToE164("invalid")).toBe(null);
      expect(normalizeToE164("")).toBe(null);
    });

    it("returns null for numbers that cannot be normalized", () => {
      // 9 digits - not US format
      expect(normalizeToE164("123456789")).toBe(null);
      // 8 digits
      expect(normalizeToE164("12345678")).toBe(null);
    });
  });

  describe("normalizePhoneNumber", () => {
    it("normalizes valid phone numbers", () => {
      expect(normalizePhoneNumber("+14155552671")).toBe("+14155552671");
      expect(normalizePhoneNumber("4155552671")).toBe("+14155552671");
      expect(normalizePhoneNumber("(415) 555-2671")).toBe("+14155552671");
    });

    it("normalizes email addresses to lowercase", () => {
      expect(normalizePhoneNumber("User@Example.com")).toBe("user@example.com");
      expect(normalizePhoneNumber("USER@EXAMPLE.COM")).toBe("user@example.com");
    });

    it("handles whitespace", () => {
      expect(normalizePhoneNumber("  +14155552671  ")).toBe("+14155552671");
      expect(normalizePhoneNumber("  user@example.com  ")).toBe("user@example.com");
    });

    it("uses default country code for normalization", () => {
      // Without country code, should normalize using default (US)
      expect(normalizePhoneNumber("4155552671")).toBe("+14155552671");
    });

    it("handles international numbers", () => {
      expect(normalizePhoneNumber("+442071838750")).toBe("+442071838750");
      expect(normalizePhoneNumber("+33612345678")).toBe("+33612345678");
    });

    it("returns cleaned version for invalid numbers", () => {
      // Invalid numbers still get cleaned
      const result = normalizePhoneNumber("abc123def456");
      expect(result).toBe("123456");
    });
  });

  describe("parsePhoneNumber", () => {
    it("parses valid phone numbers", () => {
      const result = parsePhoneNumber("+14155552671");
      expect(result).not.toBeNull();
      expect(result!.formatted).toBe("+14155552671");
      expect(result!.countryCode).toBe("1");
      expect(result!.isValid).toBe(true);
    });

    it("returns null for email addresses", () => {
      const result = parsePhoneNumber("user@example.com");
      expect(result).toBeNull();
    });

    it("returns null for invalid input", () => {
      expect(parsePhoneNumber("invalid")).toBeNull();
      expect(parsePhoneNumber("")).toBeNull();
    });

    it("includes validation status", () => {
      const validResult = parsePhoneNumber("+14155552671");
      expect(validResult?.isValid).toBe(true);
    });
  });
});

describe("Phone Normalization Edge Cases", () => {
  describe("Security-relevant tests", () => {
    it("handles very long input without crashing", () => {
      const longInput = "1".repeat(1000);
      expect(() => normalizeToE164(longInput)).not.toThrow();
      expect(() => normalizePhoneNumber(longInput)).not.toThrow();
    });

    it("handles special characters safely", () => {
      const maliciousInput = "+1<script>alert(1)</script>";
      expect(() => normalizeToE164(maliciousInput)).not.toThrow();
      expect(() => normalizePhoneNumber(maliciousInput)).not.toThrow();
    });

    it("handles null-byte injection attempts", () => {
      const nullByteInput = "+14155552671\x00extra";
      expect(() => normalizeToE164(nullByteInput)).not.toThrow();
    });

    it("handles unicode characters", () => {
      const unicodeInput = "+1\u00A04155552671"; // Non-breaking space
      expect(() => normalizePhoneNumber(unicodeInput)).not.toThrow();
    });
  });

  describe("Boundary conditions", () => {
    it("handles maximum length E.164 number (15 digits)", () => {
      // 15 digits is the max for E.164
      expect(isValidE164("+123456789012345")).toBe(true);
    });

    it("rejects 16+ digit numbers", () => {
      expect(isValidE164("+1234567890123456")).toBe(false);
    });

    it("handles minimum length E.164 number", () => {
      // Minimum is + followed by at least 2 digits
      expect(isValidE164("+12")).toBe(true);
      expect(isValidE164("+1")).toBe(false);
    });
  });
});

describe("validatePhoneForAPI", () => {
  describe("valid inputs", () => {
    it("accepts valid E.164 phone numbers", () => {
      const result = validatePhoneForAPI("+14155552671");
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.normalized).toBe("+14155552671");
      }
    });

    it("accepts and normalizes 10-digit US numbers", () => {
      const result = validatePhoneForAPI("4155552671");
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.normalized).toBe("+14155552671");
      }
    });

    it("accepts formatted phone numbers", () => {
      const result = validatePhoneForAPI("(415) 555-2671");
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.normalized).toBe("+14155552671");
      }
    });

    it("handles whitespace around phone numbers", () => {
      const result = validatePhoneForAPI("  +14155552671  ");
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.normalized).toBe("+14155552671");
      }
    });

    it("accepts international numbers", () => {
      const result = validatePhoneForAPI("+442071838750");
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.normalized).toBe("+442071838750");
      }
    });
  });

  describe("invalid inputs", () => {
    it("rejects empty string", () => {
      const result = validatePhoneForAPI("");
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Phone number is required");
      }
    });

    it("rejects whitespace-only string", () => {
      const result = validatePhoneForAPI("   ");
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Phone number is required");
      }
    });

    it("rejects invalid phone format", () => {
      const result = validatePhoneForAPI("invalid");
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Invalid phone number format");
      }
    });

    it("rejects too short numbers", () => {
      const result = validatePhoneForAPI("12345");
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Invalid phone number format");
      }
    });

    it("rejects email addresses (not phone numbers)", () => {
      const result = validatePhoneForAPI("user@example.com");
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Invalid phone number format");
      }
    });
  });

  describe("edge cases", () => {
    it("handles very long input gracefully", () => {
      const longInput = "1".repeat(50);
      const result = validatePhoneForAPI(longInput);
      // Should not throw, just return invalid
      expect(result.valid).toBe(false);
    });

    it("handles special characters", () => {
      const result = validatePhoneForAPI("+1<script>alert(1)</script>");
      expect(result.valid).toBe(false);
    });

    it("handles null-byte injection", () => {
      const result = validatePhoneForAPI("+14155552671\x00extra");
      // Should either be valid (ignoring the null byte) or invalid
      expect(typeof result.valid).toBe("boolean");
    });
  });
});
