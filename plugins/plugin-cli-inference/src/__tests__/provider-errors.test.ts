import { describe, expect, it } from "vitest";
import { isRetryableProviderStatus, ProviderApiError } from "./provider-errors.ts";

describe("isRetryableProviderStatus", () => {
  it("classifies 429/529 as retryable", () => {
    expect(isRetryableProviderStatus(429)).toBe(true);
    expect(isRetryableProviderStatus(529)).toBe(true);
  });

  it("classifies 5xx as retryable", () => {
    for (const code of [500, 502, 503, 504]) {
      expect(isRetryableProviderStatus(code)).toBe(true);
    }
  });

  it("classifies 4xx as non-retryable", () => {
    expect(isRetryableProviderStatus(400)).toBe(false);
    expect(isRetryableProviderStatus(401)).toBe(false);
    expect(isRetryableProviderStatus(404)).toBe(false);
  });

  it("detects retryable text in messages", () => {
    expect(isRetryableProviderStatus(undefined, "rate limit exceeded")).toBe(true);
    expect(isRetryableProviderStatus(undefined, "server overloaded")).toBe(true);
    expect(isRetryableProviderStatus(undefined, "request timed out")).toBe(true);
    expect(isRetryableProviderStatus(undefined, "invalid api key")).toBe(false);
  });
});

describe("ProviderApiError", () => {
  it("defaults retryable from the status", () => {
    expect(new ProviderApiError("x", { statusCode: 429 }).retryable).toBe(true);
    expect(new ProviderApiError("x", { statusCode: 400 }).retryable).toBe(false);
  });

  it("honors an explicit retryable override", () => {
    expect(new ProviderApiError("x", { statusCode: 400, retryable: true }).retryable).toBe(true);
  });
});
