import { describe, expect, it } from "vitest";
import { formatPhoneDisplay, isValidPhone, normalizePhone } from "../lib/phone";

describe("normalizePhone", () => {
  describe("valid E.164 formats", () => {
    it("normalizes US numbers", () => {
      expect(normalizePhone("+15551234567")).toBe("+15551234567");
      expect(normalizePhone("+12125551234")).toBe("+12125551234");
    });

    it("normalizes international numbers", () => {
      expect(normalizePhone("+442071234567")).toBe("+442071234567"); // UK
      expect(normalizePhone("+8613912345678")).toBe("+8613912345678"); // China
      expect(normalizePhone("+81312345678")).toBe("+81312345678"); // Japan
      expect(normalizePhone("+33123456789")).toBe("+33123456789"); // France
    });

    it("handles minimum valid length (8 digits)", () => {
      expect(normalizePhone("+12345678")).toBe("+12345678");
    });

    it("handles maximum valid length (15 digits)", () => {
      expect(normalizePhone("+123456789012345")).toBe("+123456789012345");
    });
  });

  describe("US number inference", () => {
    it("adds +1 to 10-digit numbers", () => {
      expect(normalizePhone("5551234567")).toBe("+15551234567");
      expect(normalizePhone("2125551234")).toBe("+12125551234");
    });

    it("adds + to 11-digit numbers starting with 1", () => {
      expect(normalizePhone("15551234567")).toBe("+15551234567");
      expect(normalizePhone("12125551234")).toBe("+12125551234");
    });
  });

  describe("formatting cleanup", () => {
    it("strips parentheses and dashes", () => {
      expect(normalizePhone("(555) 123-4567")).toBe("+15551234567");
      expect(normalizePhone("555-123-4567")).toBe("+15551234567");
    });

    it("strips dots", () => {
      expect(normalizePhone("555.123.4567")).toBe("+15551234567");
    });

    it("strips spaces", () => {
      expect(normalizePhone("555 123 4567")).toBe("+15551234567");
      expect(normalizePhone("+1 555 123 4567")).toBe("+15551234567");
    });

    it("handles mixed formatting", () => {
      expect(normalizePhone("+1 (555) 123-4567")).toBe("+15551234567");
      expect(normalizePhone("1-555-123-4567")).toBe("+15551234567");
    });

    it("trims leading and trailing whitespace", () => {
      expect(normalizePhone("  +15551234567  ")).toBe("+15551234567");
      expect(normalizePhone("\t+15551234567\n")).toBe("+15551234567");
    });
  });

  describe("invalid inputs", () => {
    it("rejects empty string", () => {
      expect(normalizePhone("")).toBeNull();
    });

    it("rejects whitespace-only", () => {
      expect(normalizePhone("   ")).toBeNull();
      expect(normalizePhone("\t\n")).toBeNull();
    });

    it("rejects numbers starting with 0", () => {
      expect(normalizePhone("+0123456789")).toBeNull();
    });

    it("rejects too short numbers", () => {
      expect(normalizePhone("+1234567")).toBeNull(); // 7 digits
      expect(normalizePhone("123")).toBeNull();
      expect(normalizePhone("+1")).toBeNull();
    });

    it("rejects too long numbers", () => {
      expect(normalizePhone("+1234567890123456")).toBeNull(); // 16 digits
    });

    it("rejects non-numeric strings", () => {
      expect(normalizePhone("abc")).toBeNull();
      expect(normalizePhone("phone")).toBeNull();
      expect(normalizePhone("call me")).toBeNull();
    });

    it("strips letters from mixed input (digits only)", () => {
      // Implementation strips all non-digit chars, so +1555ABC4567 -> +15554567
      // This results in an 8-digit number which is valid E.164
      expect(normalizePhone("+1555ABC4567")).toBe("+15554567");
    });

    it("handles null and undefined gracefully", () => {
      expect(normalizePhone(null as unknown as string)).toBeNull();
      expect(normalizePhone(undefined as unknown as string)).toBeNull();
    });
  });

  describe("boundary cases", () => {
    it("handles numbers with only special characters after stripping", () => {
      expect(normalizePhone("---")).toBeNull();
      expect(normalizePhone("()")).toBeNull();
    });

    it("handles 9-digit numbers (valid for some countries)", () => {
      // 9 digits is valid E.164 (8-15 digits after +)
      expect(normalizePhone("123456789")).toBe("+123456789");
    });

    it("preserves country codes for non-US numbers", () => {
      expect(normalizePhone("+491234567890")).toBe("+491234567890"); // Germany
    });
  });
});

describe("isValidPhone", () => {
  describe("valid E.164 formats", () => {
    it("validates US numbers", () => {
      expect(isValidPhone("+15551234567")).toBe(true);
      expect(isValidPhone("+12125551234")).toBe(true);
    });

    it("validates international numbers", () => {
      expect(isValidPhone("+442071234567")).toBe(true);
      expect(isValidPhone("+8613912345678")).toBe(true);
    });

    it("validates minimum length (8 digits after +)", () => {
      expect(isValidPhone("+12345678")).toBe(true);
    });

    it("validates maximum length (15 digits after +)", () => {
      expect(isValidPhone("+123456789012345")).toBe(true);
    });
  });

  describe("invalid formats", () => {
    it("rejects numbers without +", () => {
      expect(isValidPhone("15551234567")).toBe(false);
      expect(isValidPhone("5551234567")).toBe(false);
    });

    it("rejects too short numbers", () => {
      expect(isValidPhone("+1234567")).toBe(false);
      expect(isValidPhone("+1")).toBe(false);
    });

    it("rejects too long numbers", () => {
      expect(isValidPhone("+1234567890123456")).toBe(false);
    });

    it("rejects numbers starting with +0", () => {
      expect(isValidPhone("+0123456789")).toBe(false);
    });

    it("rejects empty strings", () => {
      expect(isValidPhone("")).toBe(false);
    });

    it("rejects formatted numbers", () => {
      expect(isValidPhone("+1 555 123 4567")).toBe(false);
      expect(isValidPhone("+1-555-123-4567")).toBe(false);
    });
  });
});

describe("formatPhoneDisplay", () => {
  describe("US/Canada formatting", () => {
    it("formats +1 E.164 numbers", () => {
      expect(formatPhoneDisplay("+15551234567")).toBe("(555) 123-4567");
      expect(formatPhoneDisplay("+12125551234")).toBe("(212) 555-1234");
    });

    it("formats 10-digit numbers", () => {
      expect(formatPhoneDisplay("5551234567")).toBe("(555) 123-4567");
    });

    it("formats 11-digit numbers starting with 1", () => {
      expect(formatPhoneDisplay("15551234567")).toBe("(555) 123-4567");
    });
  });

  describe("international numbers", () => {
    it("returns original for non-US numbers", () => {
      expect(formatPhoneDisplay("+442071234567")).toBe("+442071234567");
      expect(formatPhoneDisplay("+8613912345678")).toBe("+8613912345678");
    });

    it("returns original for numbers with 12+ digits", () => {
      expect(formatPhoneDisplay("+491234567890")).toBe("+491234567890");
    });
  });

  describe("edge cases", () => {
    it("handles empty string", () => {
      expect(formatPhoneDisplay("")).toBe("");
    });

    it("handles short numbers (returns original)", () => {
      expect(formatPhoneDisplay("+1234")).toBe("+1234");
    });

    it("handles already formatted numbers", () => {
      // Should still extract digits and reformat
      expect(formatPhoneDisplay("(555) 123-4567")).toBe("(555) 123-4567");
    });
  });
});
