/**
 * Tests for uncaught error formatting and unhandled rejection classification.
 */
import { describe, expect, it } from "vitest";
import {
  formatUncaughtError,
  shouldIgnoreUnhandledRejection,
} from "./error-classification.ts";

describe("formatUncaughtError", () => {
  it("formats Error instances with stack or message", () => {
    const err = new Error("Something broke");
    expect(formatUncaughtError(err)).toContain("Something broke");
    expect(formatUncaughtError(err)).toContain("Error:");

    const stacklessErr = new Error("No stack here");
    delete (stacklessErr as { stack?: unknown }).stack;
    expect(formatUncaughtError(stacklessErr)).toBe("No stack here");
  });

  it("extracts stack or message from error-like plain objects", () => {
    expect(formatUncaughtError({ stack: "CustomStack: error occurred" })).toBe(
      "CustomStack: error occurred",
    );

    expect(formatUncaughtError({ message: "Custom message occurred" })).toBe(
      "Custom message occurred",
    );
  });

  it("formats string and number primitives", () => {
    expect(formatUncaughtError("plain string error")).toBe(
      "plain string error",
    );
    expect(formatUncaughtError(500)).toBe("500");
  });

  it("returns empty string for null and undefined", () => {
    expect(formatUncaughtError(null)).toBe("");
    expect(formatUncaughtError(undefined)).toBe("");
  });
});

describe("shouldIgnoreUnhandledRejection", () => {
  it("identifies direct AI credit exhaustion errors", () => {
    expect(
      shouldIgnoreUnhandledRejection(
        new Error("AI_APICallError: insufficient_quota"),
      ),
    ).toBe(true);

    expect(
      shouldIgnoreUnhandledRejection(
        new Error("AI_NoOutputGeneratedError: out of credits for model"),
      ),
    ).toBe(true);

    expect(
      shouldIgnoreUnhandledRejection({
        name: "AI_APICallError",
        message: "No output generated",
        statusCode: 402,
      }),
    ).toBe(true);

    expect(
      shouldIgnoreUnhandledRejection({
        name: "AI_RetryError",
        message: "AI_RetryError occurred",
        responseBody: "Payment Required: insufficient credits",
      }),
    ).toBe(true);
  });

  it("detects credit errors nested in cause chains", () => {
    const root = new Error("Top level failure", {
      cause: new Error("AI_APICallError: payment required"),
    });
    expect(shouldIgnoreUnhandledRejection(root)).toBe(true);
  });

  it("detects credit errors nested in AggregateError errors array", () => {
    const aggregate = new AggregateError([
      new Error("Normal failure"),
      new Error("AI_NoOutputGeneratedError: insufficient credits"),
    ]);
    expect(shouldIgnoreUnhandledRejection(aggregate)).toBe(true);
  });

  it("handles circular object graphs safely without infinite loops", () => {
    const circular: Record<string, unknown> = {
      message: "Generic error",
    };
    circular.cause = circular;
    expect(shouldIgnoreUnhandledRejection(circular)).toBe(false);
  });

  it("returns false for non-ignorable application errors", () => {
    expect(shouldIgnoreUnhandledRejection(new Error("Database offline"))).toBe(
      false,
    );
    expect(
      shouldIgnoreUnhandledRejection(new TypeError("Cannot read properties")),
    ).toBe(false);
    expect(shouldIgnoreUnhandledRejection("Fatal crash")).toBe(false);
    expect(shouldIgnoreUnhandledRejection(null)).toBe(false);
    expect(shouldIgnoreUnhandledRejection(undefined)).toBe(false);
  });
});
