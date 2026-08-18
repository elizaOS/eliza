/**
 * Tests for browser-safe error formatting in formatErrorWithStack.
 */
import { describe, expect, it } from "vitest";
import { formatErrorWithStack } from "./format-error.ts";

describe("formatErrorWithStack", () => {
  it("formats standard Error instances with stack", () => {
    const error = new Error("something went wrong");
    const formatted = formatErrorWithStack(error);
    expect(formatted).toContain("Error: something went wrong");
    expect(formatted).toContain("format-error.test.ts");
  });

  it("falls back to message when Error stack is empty or whitespace", () => {
    const error = new Error("custom message");
    error.stack = "";
    expect(formatErrorWithStack(error)).toBe("custom message");

    error.stack = "   ";
    expect(formatErrorWithStack(error)).toBe("custom message");
  });

  it("extracts stack from error-like plain objects", () => {
    const errorObj = {
      message: "rpc failed",
      stack: "Error: rpc failed\n    at remoteWorker (worker.js:10:5)",
    };
    expect(formatErrorWithStack(errorObj)).toBe(
      "Error: rpc failed\n    at remoteWorker (worker.js:10:5)",
    );
  });

  it("extracts message from error-like plain objects without stack", () => {
    const errorObj = { message: "network timeout" };
    expect(formatErrorWithStack(errorObj)).toBe("network timeout");
  });

  it("falls back to message when error-like object stack is whitespace", () => {
    const errorObj = { message: "db unavailable", stack: "   " };
    expect(formatErrorWithStack(errorObj)).toBe("db unavailable");
  });

  it("formats primitive strings directly", () => {
    expect(formatErrorWithStack("direct string error")).toBe(
      "direct string error",
    );
  });

  it("formats numbers and booleans via String conversion", () => {
    expect(formatErrorWithStack(404)).toBe("404");
    expect(formatErrorWithStack(false)).toBe("false");
  });

  it("handles null and undefined safely", () => {
    expect(formatErrorWithStack(null)).toBe("null");
    expect(formatErrorWithStack(undefined)).toBe("undefined");
  });

  it("falls back to String representation for arbitrary plain objects", () => {
    expect(formatErrorWithStack({})).toBe("[object Object]");
  });
});
