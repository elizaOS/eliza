/**
 * Tests for BlueSky types.
 */

import { describe, expect, it } from "bun:test";
import { BlueSkyError, CACHE_SIZES, CACHE_TTLS, ERROR_MESSAGES } from "../../types";

describe("BlueSkyError", () => {
  it("should create an error with message", () => {
    const error = new BlueSkyError("Test error");
    expect(error.message).toBe("Test error");
    expect(error.name).toBe("BlueSkyError");
  });

  it("should create an error with code", () => {
    const error = new BlueSkyError("Test error", "AUTH_FAILED");
    expect(error.code).toBe("AUTH_FAILED");
  });

  it("should create an error with status", () => {
    const error = new BlueSkyError("Test error", "NETWORK_ERROR", 500);
    expect(error.status).toBe(500);
  });

  it("should create an error with details", () => {
    const details = { extra: "info" };
    const error = new BlueSkyError("Test error", "UNKNOWN", undefined, details);
    expect(error.details).toEqual(details);
  });
});

describe("Cache Configuration", () => {
  it("should have valid TTLs", () => {
    expect(CACHE_TTLS.PROFILE).toBe(3600000); // 1 hour
    expect(CACHE_TTLS.TIMELINE).toBe(300000); // 5 minutes
    expect(CACHE_TTLS.POST).toBe(1800000); // 30 minutes
  });

  it("should have valid sizes", () => {
    expect(CACHE_SIZES.PROFILE).toBe(1000);
    expect(CACHE_SIZES.POST).toBe(10000);
    expect(CACHE_SIZES.CONVERSATIONS).toBe(100);
  });
});

describe("Error Messages", () => {
  it("should have all required error messages", () => {
    expect(ERROR_MESSAGES.NOT_AUTHENTICATED).toBeDefined();
    expect(ERROR_MESSAGES.INVALID_HANDLE).toBeDefined();
    expect(ERROR_MESSAGES.MISSING_CREDENTIALS).toBeDefined();
    expect(ERROR_MESSAGES.POST_TOO_LONG).toBeDefined();
    expect(ERROR_MESSAGES.RATE_LIMITED).toBeDefined();
  });
});
