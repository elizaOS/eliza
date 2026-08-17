/**
 * Unit tests for shared error classification helpers in packages/shared/src/utils/errors.ts.
 */

import { describe, expect, it } from "vitest";
import { errorMessage, isRedirectResponse, isTimeoutError } from "./errors";

describe("isTimeoutError", () => {
  it("identifies standard TimeoutError and AbortError instances", () => {
    const timeoutErr = new Error("Gateway timeout");
    timeoutErr.name = "TimeoutError";
    expect(isTimeoutError(timeoutErr)).toBe(true);

    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    expect(isTimeoutError(abortErr)).toBe(true);
  });

  it("identifies timeout keywords in Error message", () => {
    expect(isTimeoutError(new Error("Request timed out after 5000ms"))).toBe(
      true,
    );
    expect(isTimeoutError(new Error("Connection timeout"))).toBe(true);
    expect(isTimeoutError(new Error("Database connection refused"))).toBe(
      false,
    );
  });

  it("identifies timeout keywords in plain string errors", () => {
    expect(isTimeoutError("request timed out")).toBe(true);
    expect(isTimeoutError("Network timeout")).toBe(true);
    expect(isTimeoutError("Bad request")).toBe(false);
  });

  it("identifies duck-typed error objects", () => {
    expect(isTimeoutError({ name: "TimeoutError" })).toBe(true);
    expect(isTimeoutError({ name: "AbortError" })).toBe(true);
    expect(isTimeoutError({ message: "Socket timed out" })).toBe(true);
    expect(isTimeoutError({ message: "Invalid payload" })).toBe(false);
  });

  it("returns false for null, undefined, and non-timeout values", () => {
    expect(isTimeoutError(null)).toBe(false);
    expect(isTimeoutError(undefined)).toBe(false);
    expect(isTimeoutError(123)).toBe(false);
    expect(isTimeoutError({})).toBe(false);
  });
});

describe("isRedirectResponse", () => {
  it("identifies 3xx HTTP redirect responses", () => {
    expect(isRedirectResponse({ status: 301 } as Response)).toBe(true);
    expect(isRedirectResponse({ status: 302 } as Response)).toBe(true);
    expect(isRedirectResponse({ status: 307 } as Response)).toBe(true);
    expect(isRedirectResponse({ status: 308 } as Response)).toBe(true);
  });

  it("returns false for non-3xx status codes", () => {
    expect(isRedirectResponse({ status: 200 } as Response)).toBe(false);
    expect(isRedirectResponse({ status: 201 } as Response)).toBe(false);
    expect(isRedirectResponse({ status: 400 } as Response)).toBe(false);
    expect(isRedirectResponse({ status: 404 } as Response)).toBe(false);
    expect(isRedirectResponse({ status: 500 } as Response)).toBe(false);
  });

  it("returns false safely for null, undefined, non-objects, and invalid status values", () => {
    expect(isRedirectResponse(null as unknown as Response)).toBe(false);
    expect(isRedirectResponse(undefined as unknown as Response)).toBe(false);
    expect(isRedirectResponse({} as Response)).toBe(false);
    expect(isRedirectResponse({ status: "302" } as unknown as Response)).toBe(
      false,
    );
    expect(
      isRedirectResponse({ status: Number.NaN } as unknown as Response),
    ).toBe(false);
    expect(
      isRedirectResponse({
        status: Number.POSITIVE_INFINITY,
      } as unknown as Response),
    ).toBe(false);
  });
});

describe("errorMessage", () => {
  it("extracts message from Error instance or falls back cleanly", () => {
    expect(errorMessage(new Error("Something went wrong"))).toBe(
      "Something went wrong",
    );
    expect(errorMessage("Custom error string")).toBe("Custom error string");
  });
});
