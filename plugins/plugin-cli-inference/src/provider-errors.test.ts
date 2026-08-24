/**
 * Deterministic unit test for provider-errors (plugin-cli-inference): the
 * retryability classifier and the streamed "API Error" envelope parser shared
 * by the CLI and SDK handlers. Pins 429/529/5xx retry classification, message
 * keyword fallbacks, envelope parsing, and non-matching rejection.
 * Pure-function test — no runtime.
 */
import { describe, expect, it } from "vitest";
import {
  isProviderApiErrorText,
  isRetryableProviderStatus,
  ProviderApiError,
  parseProviderApiErrorText,
} from "./provider-errors.ts";

describe("isRetryableProviderStatus — status-code classification", () => {
  it("classifies 429 and 529 as retryable", () => {
    expect(isRetryableProviderStatus(429)).toBe(true);
    expect(isRetryableProviderStatus(529)).toBe(true);
  });

  it("classifies 500/502/503/504 as retryable", () => {
    for (const code of [500, 502, 503, 504]) {
      expect(isRetryableProviderStatus(code)).toBe(true);
    }
  });

  it("classifies 4xx client errors as non-retryable", () => {
    for (const code of [400, 401, 403, 404, 422]) {
      expect(isRetryableProviderStatus(code)).toBe(false);
    }
  });

  it("classifies 501 and 505 as non-retryable", () => {
    expect(isRetryableProviderStatus(501)).toBe(false);
    expect(isRetryableProviderStatus(505)).toBe(false);
  });

  it("classifies an undefined status as non-retryable", () => {
    expect(isRetryableProviderStatus(undefined)).toBe(false);
  });
});

describe("isRetryableProviderStatus — message keyword fallback", () => {
  it("classifies overloaded / rate-limit / too-many-requests messages", () => {
    expect(isRetryableProviderStatus(undefined, "server overloaded")).toBe(true);
    expect(isRetryableProviderStatus(undefined, "rate limit exceeded")).toBe(true);
    expect(isRetryableProviderStatus(undefined, "too many requests")).toBe(true);
  });

  it("classifies unavailable / timeout messages", () => {
    expect(isRetryableProviderStatus(undefined, "temporarily unavailable")).toBe(true);
    expect(isRetryableProviderStatus(undefined, "service unavailable")).toBe(true);
    expect(isRetryableProviderStatus(undefined, "request timed out")).toBe(true);
    expect(isRetryableProviderStatus(undefined, "timeout after 30s")).toBe(true);
  });

  it("matches keywords case-insensitively", () => {
    expect(isRetryableProviderStatus(undefined, "Server Overloaded")).toBe(true);
    expect(isRetryableProviderStatus(undefined, "RATE LIMIT")).toBe(true);
  });

  it("does not match unrelated messages", () => {
    expect(isRetryableProviderStatus(undefined, "invalid api key")).toBe(false);
    expect(isRetryableProviderStatus(undefined, "context too long")).toBe(false);
    expect(isRetryableProviderStatus(undefined, "")).toBe(false);
  });

  it("prefers an explicit retryable flag over inferred status", () => {
    expect(new ProviderApiError("x", { statusCode: 400, retryable: true }).retryable).toBe(true);
    expect(new ProviderApiError("x", { statusCode: 429, retryable: false }).retryable).toBe(false);
  });
});

describe("ProviderApiError — coded error shape", () => {
  it("carries name, statusCode, and retryable defaults", () => {
    const error = new ProviderApiError("boom", { statusCode: 503 });
    expect(error.name).toBe("ProviderApiError");
    expect(error.statusCode).toBe(503);
    expect(error.retryable).toBe(true);
    expect(error).toBeInstanceOf(Error);
  });

  it("infers retryable from the message when no status is given", () => {
    expect(new ProviderApiError("the server is overloaded").retryable).toBe(true);
    expect(new ProviderApiError("bad request").retryable).toBe(false);
  });

  it("preserves the cause when provided", () => {
    const cause = new Error("upstream");
    const error = new ProviderApiError("boom", { cause });
    expect((error as Error & { cause?: unknown }).cause).toBe(cause);
  });
});

describe("parseProviderApiErrorText — envelope parsing", () => {
  it("parses a numeric status envelope", () => {
    expect(parseProviderApiErrorText("API Error: 429 Too Many Requests")).toEqual({
      statusCode: 429,
      message: "API Error: 429 Too Many Requests",
    });
  });

  it("parses a numeric envelope with leading whitespace", () => {
    expect(parseProviderApiErrorText("  API Error: 503 Service Unavailable  ")).toEqual({
      statusCode: 503,
      message: "API Error: 503 Service Unavailable",
    });
  });

  it("parses a non-numeric envelope with undefined status", () => {
    expect(parseProviderApiErrorText("API Error: Request was aborted.")).toEqual({
      statusCode: undefined,
      message: "API Error: Request was aborted.",
    });
  });

  it("parses the bare prefix without a colon", () => {
    expect(parseProviderApiErrorText("API Error")).toEqual({
      statusCode: undefined,
      message: "API Error",
    });
  });

  it("matches case-insensitively", () => {
    expect(parseProviderApiErrorText("api error: 500")).toEqual({
      statusCode: 500,
      message: "api error: 500",
    });
  });

  it("treats a four-digit status as a non-numeric envelope", () => {
    // The envelope prefix still matches; only the 3-digit status is absent.
    expect(parseProviderApiErrorText("API Error: 4299")).toEqual({
      statusCode: undefined,
      message: "API Error: 4299",
    });
  });

  it("rejects text that is not an API Error envelope", () => {
    expect(parseProviderApiErrorText("error: 429")).toBeNull();
    expect(parseProviderApiErrorText("Internal Server Error")).toBeNull();
    expect(parseProviderApiErrorText("not an error")).toBeNull();
    expect(parseProviderApiErrorText("")).toBeNull();
  });

  it("rejects a leading numeric that is not exactly three digits", () => {
    expect(parseProviderApiErrorText("API Error: 42")).toEqual({
      statusCode: undefined,
      message: "API Error: 42",
    });
  });
});

describe("isProviderApiErrorText — convenience predicate", () => {
  it("returns true only for API Error envelopes", () => {
    expect(isProviderApiErrorText("API Error: 500")).toBe(true);
    expect(isProviderApiErrorText("API Error: aborted")).toBe(true);
    expect(isProviderApiErrorText("some other error")).toBe(false);
  });
});
