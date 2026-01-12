import { describe, expect, it } from "vitest";
import { BlueSkyError, CACHE_SIZE, CACHE_TTL } from "../../types";

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
});

describe("Cache Configuration", () => {
  it("should have valid TTLs", () => {
    expect(CACHE_TTL.PROFILE).toBe(3600000);
    expect(CACHE_TTL.TIMELINE).toBe(300000);
    expect(CACHE_TTL.POST).toBe(1800000);
  });

  it("should have valid sizes", () => {
    expect(CACHE_SIZE.PROFILE).toBe(1000);
    expect(CACHE_SIZE.POST).toBe(10000);
    expect(CACHE_SIZE.CONVERSATIONS).toBe(100);
  });
});
