/**
 * Decimal Converter Unit Tests
 * Tests for safe conversion of Decimal values to strings and numbers
 */

import { describe, expect, it } from "bun:test";
import {
  convertBalanceToStrings,
  toSafeNumber,
  toSafeString,
} from "@feed/shared";

describe("Decimal Converter", () => {
  describe("toSafeString", () => {
    it("should convert string values", () => {
      expect(toSafeString("123.45")).toBe("123.45");
      expect(toSafeString("0")).toBe("0");
      expect(toSafeString("100")).toBe("100");
    });

    it("should convert number values", () => {
      expect(toSafeString(123.45)).toBe("123.45");
      expect(toSafeString(0)).toBe("0");
      expect(toSafeString(100)).toBe("100");
    });

    it("should handle null/undefined with default value", () => {
      expect(toSafeString(null)).toBe("0");
      expect(toSafeString(undefined)).toBe("0");
      expect(toSafeString(null, "100")).toBe("100");
      expect(toSafeString(undefined, "50")).toBe("50");
    });

    it("should handle objects with toString method", () => {
      const decimalLike = {
        toString: () => "999.99",
      };
      expect(toSafeString(decimalLike)).toBe("999.99");
    });

    it("should handle edge cases", () => {
      expect(toSafeString(0)).toBe("0");
      expect(toSafeString(-123.45)).toBe("-123.45");
      expect(toSafeString(Number.MAX_SAFE_INTEGER)).toBe(
        String(Number.MAX_SAFE_INTEGER),
      );
    });
  });

  describe("toSafeNumber", () => {
    it("should convert number values", () => {
      expect(toSafeNumber(123.45)).toBe(123.45);
      expect(toSafeNumber(0)).toBe(0);
      expect(toSafeNumber(100)).toBe(100);
    });

    it("should convert string values", () => {
      expect(toSafeNumber("123.45")).toBe(123.45);
      expect(toSafeNumber("0")).toBe(0);
      expect(toSafeNumber("100")).toBe(100);
    });

    it("should handle null/undefined with default value", () => {
      expect(toSafeNumber(null)).toBe(0);
      expect(toSafeNumber(undefined)).toBe(0);
      expect(toSafeNumber(null, 100)).toBe(100);
      expect(toSafeNumber(undefined, 50)).toBe(50);
    });

    it("should handle objects with toString method", () => {
      const decimalLike = {
        toString: () => "999.99",
      };
      expect(toSafeNumber(decimalLike)).toBe(999.99);
    });

    it("should return default for invalid strings", () => {
      expect(toSafeNumber("invalid")).toBe(0);
      expect(toSafeNumber("invalid", 100)).toBe(100);
      expect(toSafeNumber("NaN", 50)).toBe(50);
    });

    it("should handle edge cases", () => {
      expect(toSafeNumber(0)).toBe(0);
      expect(toSafeNumber(-123.45)).toBe(-123.45);
      expect(toSafeNumber("   123.45   ")).toBe(123.45);
    });
  });

  describe("convertBalanceToStrings", () => {
    it("should convert all balance fields to strings", () => {
      const result = convertBalanceToStrings({
        virtualBalance: 1000.5,
        totalDeposited: 5000,
        totalWithdrawn: 500,
        lifetimePnL: -200.25,
      });

      expect(result.virtualBalance).toBe("1000.5");
      expect(result.totalDeposited).toBe("5000");
      expect(result.totalWithdrawn).toBe("500");
      expect(result.lifetimePnL).toBe("-200.25");
    });

    it("should handle undefined fields with defaults", () => {
      const result = convertBalanceToStrings({});

      expect(result.virtualBalance).toBe("0");
      expect(result.totalDeposited).toBe("0");
      expect(result.totalWithdrawn).toBe("0");
      expect(result.lifetimePnL).toBe("0");
    });

    it("should handle string inputs", () => {
      const result = convertBalanceToStrings({
        virtualBalance: "1000.50",
        totalDeposited: "5000.00",
        totalWithdrawn: "500.00",
        lifetimePnL: "-200.25",
      });

      expect(result.virtualBalance).toBe("1000.50");
      expect(result.totalDeposited).toBe("5000.00");
      expect(result.totalWithdrawn).toBe("500.00");
      expect(result.lifetimePnL).toBe("-200.25");
    });
  });
});
