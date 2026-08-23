/**
 * Unit coverage for error-formatting and unhandled rejection classification
 * in error-classification.ts.
 *
 * Covers formatUncaughtError and shouldIgnoreUnhandledRejection across
 * AI provider credit-exhaustion patterns, 402 status codes, responseBody
 * inspection, nested cause chains, AggregateError arrays, and circular graphs.
 */

import { describe, expect, it } from "vitest";
import {
  formatUncaughtError,
  shouldIgnoreUnhandledRejection,
} from "./error-classification.js";

describe("error-classification", () => {
  describe("formatUncaughtError", () => {
    it("formats standard Error objects with message", () => {
      const error = new Error("Something went wrong");
      expect(formatUncaughtError(error)).toContain("Something went wrong");
    });

    it("formats plain string errors", () => {
      expect(formatUncaughtError("fatal crash")).toBe("fatal crash");
    });

    it("formats null and undefined gracefully", () => {
      expect(formatUncaughtError(null)).toBe("null");
      expect(formatUncaughtError(undefined)).toBe("undefined");
    });

    it("formats arbitrary objects", () => {
      expect(
        formatUncaughtError({ code: "ERR_CUSTOM", message: "fail" }),
      ).toContain("fail");
    });
  });

  describe("shouldIgnoreUnhandledRejection", () => {
    it("returns true for AI_APICallError with insufficient credits in message", () => {
      const err = new Error(
        "AI_APICallError: insufficient_quota: You exceeded your current quota",
      );
      expect(shouldIgnoreUnhandledRejection(err)).toBe(true);
    });

    it("returns true for AI_RetryError with out of credits signal", () => {
      const err = new Error("AI_RetryError: out of credits, please top up");
      expect(shouldIgnoreUnhandledRejection(err)).toBe(true);
    });

    it("returns true for AI_NoOutputGeneratedError with payment required", () => {
      const err = new Error(
        "AI_NoOutputGeneratedError: payment required to continue generation",
      );
      expect(shouldIgnoreUnhandledRejection(err)).toBe(true);
    });

    it("returns true for provider error with statusCode 402", () => {
      const err = Object.assign(new Error("AI_APICallError: request failed"), {
        statusCode: 402,
      });
      expect(shouldIgnoreUnhandledRejection(err)).toBe(true);
    });

    it("returns true for provider error with insufficient credits in responseBody", () => {
      const err = Object.assign(
        new Error("AI_APICallError: upstream rejection"),
        {
          responseBody: JSON.stringify({
            error: { message: "insufficient credits available" },
          }),
        },
      );
      expect(shouldIgnoreUnhandledRejection(err)).toBe(true);
    });

    it("returns true when credit error is nested inside cause", () => {
      const inner = new Error("AI_APICallError: statusCode: 402");
      const outer = new Error("Wrapper failure", { cause: inner });
      expect(shouldIgnoreUnhandledRejection(outer)).toBe(true);
    });

    it("returns true when credit error is in AggregateError errors array", () => {
      const creditErr = new Error("AI_APICallError: insufficient credits");
      const aggregate = new AggregateError(
        [new Error("network blip"), creditErr],
        "Multiple failures",
      );
      expect(shouldIgnoreUnhandledRejection(aggregate)).toBe(true);
    });

    it("handles circular cause references without hanging and returns true if matching", () => {
      const errA = Object.assign(new Error("AI_APICallError: top error"), {
        cause: undefined as unknown,
      });
      const errB = Object.assign(
        new Error("AI_APICallError: insufficient_quota in cycle"),
        { cause: errA },
      );
      errA.cause = errB;

      expect(shouldIgnoreUnhandledRejection(errA)).toBe(true);
    });

    it("returns false for generic errors unrelated to AI provider credit exhaustion", () => {
      expect(
        shouldIgnoreUnhandledRejection(new Error("Database connection lost")),
      ).toBe(false);
      expect(
        shouldIgnoreUnhandledRejection(
          new TypeError("Cannot read properties of undefined"),
        ),
      ).toBe(false);
      expect(shouldIgnoreUnhandledRejection("Syntax error in template")).toBe(
        false,
      );
    });

    it("returns false for provider errors without credit exhaustion signals", () => {
      const err = new Error("AI_APICallError: 500 Internal Server Error");
      expect(shouldIgnoreUnhandledRejection(err)).toBe(false);
    });
  });
});
