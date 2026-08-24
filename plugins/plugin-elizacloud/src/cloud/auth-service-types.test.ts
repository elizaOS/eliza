import { describe, expect, it } from "vitest";
import {
  isCloudAuthApiKeyService,
  normalizeCloudApiKey,
} from "./auth-service-types";

describe("isCloudAuthApiKeyService", () => {
  it("rejects null and undefined", () => {
    expect(isCloudAuthApiKeyService(null)).toBe(false);
    expect(isCloudAuthApiKeyService(undefined)).toBe(false);
  });

  it("rejects plain objects without an isAuthenticated function", () => {
    expect(isCloudAuthApiKeyService({})).toBe(false);
    expect(isCloudAuthApiKeyService({ getApiKey: () => "k" })).toBe(false);
  });

  it("accepts services exposing isAuthenticated as a function", () => {
    const svc = { isAuthenticated: () => true, getApiKey: () => "k" };
    expect(isCloudAuthApiKeyService(svc)).toBe(true);
  });

  it("rejects isAuthenticated values that are not functions", () => {
    expect(isCloudAuthApiKeyService({ isAuthenticated: "yes" })).toBe(false);
    expect(isCloudAuthApiKeyService({ isAuthenticated: true })).toBe(false);
  });
});

describe("normalizeCloudApiKey", () => {
  it("returns null for null, undefined, and non-strings", () => {
    expect(normalizeCloudApiKey(null)).toBeNull();
    expect(normalizeCloudApiKey(undefined)).toBeNull();
    expect(normalizeCloudApiKey(42 as unknown as string)).toBeNull();
  });

  it("returns null for empty and whitespace-only input", () => {
    expect(normalizeCloudApiKey("")).toBeNull();
    expect(normalizeCloudApiKey("   ")).toBeNull();
  });

  it("returns null for the [REDACTED] sentinel case-insensitively", () => {
    expect(normalizeCloudApiKey("[REDACTED]")).toBeNull();
    expect(normalizeCloudApiKey("[redacted]")).toBeNull();
    expect(normalizeCloudApiKey("[Redacted]")).toBeNull();
  });

  it("trims surrounding whitespace from a real key", () => {
    expect(normalizeCloudApiKey("  sk-abc123  ")).toBe("sk-abc123");
  });

  it("preserves a plain key untouched", () => {
    expect(normalizeCloudApiKey("sk-live-xyz")).toBe("sk-live-xyz");
  });
});
