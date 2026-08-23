import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
  formatError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import { errorMessage, isRedirectResponse, isTimeoutError } from "./errors.ts";

describe("isTimeoutError", () => {
  it("detects TimeoutError/AbortError names", () => {
    const err = new Error("x");
    err.name = "TimeoutError";
    expect(isTimeoutError(err)).toBe(true);
    const abort = new Error("x");
    abort.name = "AbortError";
    expect(isTimeoutError(abort)).toBe(true);
  });

  it("detects timeout text in messages", () => {
    expect(isTimeoutError(new Error("request timed out"))).toBe(true);
    expect(isTimeoutError(new Error("fetch timeout after 30s"))).toBe(true);
  });

  it("detects timeout shapes on plain objects", () => {
    expect(isTimeoutError({ name: "TimeoutError" })).toBe(true);
    expect(isTimeoutError({ message: "timed out" })).toBe(true);
  });

  it("detects timeout strings", () => {
    expect(isTimeoutError("operation timed out")).toBe(true);
    expect(isTimeoutError("no")).toBe(false);
  });

  it("rejects falsy and unrelated values", () => {
    expect(isTimeoutError(null)).toBe(false);
    expect(isTimeoutError(undefined)).toBe(false);
    expect(isTimeoutError(42)).toBe(false);
    expect(isTimeoutError(new Error("other"))).toBe(false);
  });
});

describe("isRedirectResponse", () => {
  it("accepts 3xx statuses", () => {
    expect(isRedirectResponse({ status: 301 } as Response)).toBe(true);
    expect(isRedirectResponse({ status: 302 } as Response)).toBe(true);
    expect(isRedirectResponse({ status: 399 } as Response)).toBe(true);
  });

  it("rejects non-3xx and malformed", () => {
    expect(isRedirectResponse({ status: 200 } as Response)).toBe(false);
    expect(isRedirectResponse({ status: 404 } as Response)).toBe(false);
    expect(isRedirectResponse(null as never)).toBe(false);
    expect(isRedirectResponse({} as never)).toBe(false);
  });
});

describe("errorMessage", () => {
  it("formats errors and values", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("raw")).toBe("raw");
  });
});
