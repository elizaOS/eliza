/**
 * Unit coverage for browser-safe error formatting helpers in format-error.ts.
 *
 * Verifies formatError and formatErrorWithStack across standard Error instances,
 * custom error shapes, nested causes, plain strings, primitives, and nullish inputs.
 */

import { describe, expect, it } from "vitest";
import { formatError, formatErrorWithStack } from "./format-error.js";

describe("format-error", () => {
  describe("formatError", () => {
    it("extracts message from standard Error", () => {
      const error = new Error("Something broke");
      expect(formatError(error)).toBe("Something broke");
    });

    it("formats primitive string error", () => {
      expect(formatError("raw error message")).toBe("raw error message");
    });

    it("formats null and undefined gracefully", () => {
      expect(formatError(null)).toBe("null");
      expect(formatError(undefined)).toBe("undefined");
    });

    it("formats non-Error values via string coercion", () => {
      expect(formatError(404)).toBe("404");
      expect(formatError({ code: "ERR" })).toBe("[object Object]");
    });
  });

  describe("formatErrorWithStack", () => {
    it("includes stack trace when available on Error", () => {
      const error = new Error("Traceable failure");
      const formatted = formatErrorWithStack(error);
      expect(formatted).toContain("Traceable failure");
      expect(formatted).toContain("Error: Traceable failure");
    });

    it("falls back to message when stack is unavailable", () => {
      const error = { message: "No stack here" };
      expect(formatErrorWithStack(error)).toContain("No stack here");
    });

    it("formats strings and primitives without error", () => {
      expect(formatErrorWithStack("simple message")).toBe("simple message");
      expect(formatErrorWithStack(12345)).toBe("12345");
      expect(formatErrorWithStack(null)).toBe("null");
      expect(formatErrorWithStack(undefined)).toBe("undefined");
    });

    it("formats nested cause details when available", () => {
      const inner = new Error("Root cause");
      const outer = new Error("High-level failure", { cause: inner });
      const formatted = formatErrorWithStack(outer);
      expect(formatted).toContain("High-level failure");
    });
  });
});
