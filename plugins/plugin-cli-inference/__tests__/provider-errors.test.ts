/**
 * Coverage for the CLI inference provider-error classification — retryable
 * status codes, message heuristics, and SDK streamed-envelope parsing.
 */
import { describe, expect, it } from "vitest";
import {
  isProviderApiErrorText,
  isRetryableProviderStatus,
  ProviderApiError,
  parseProviderApiErrorText,
} from "../src/provider-errors.ts";

describe("isRetryableProviderStatus", () => {
  it("classifies 429 and 529 as retryable regardless of message", () => {
    expect(isRetryableProviderStatus(429)).toBe(true);
    expect(isRetryableProviderStatus(529)).toBe(true);
    expect(isRetryableProviderStatus(429, "ok")).toBe(true);
  });

  it("classifies 5xx as retryable", () => {
    expect(isRetryableProviderStatus(500)).toBe(true);
    expect(isRetryableProviderStatus(502)).toBe(true);
    expect(isRetryableProviderStatus(503)).toBe(true);
    expect(isRetryableProviderStatus(504)).toBe(true);
  });

  it("does not classify 400/401/403/404 as retryable by status alone", () => {
    expect(isRetryableProviderStatus(400)).toBe(false);
    expect(isRetryableProviderStatus(401)).toBe(false);
    expect(isRetryableProviderStatus(403)).toBe(false);
    expect(isRetryableProviderStatus(404)).toBe(false);
  });

  it("classifies textual signals as retryable when status is absent or non-retryable", () => {
    expect(isRetryableProviderStatus(undefined, "overloaded")).toBe(true);
    expect(isRetryableProviderStatus(undefined, "Rate limit exceeded")).toBe(true);
    expect(isRetryableProviderStatus(undefined, "too many requests")).toBe(true);
    expect(isRetryableProviderStatus(undefined, "temporarily unavailable")).toBe(true);
    expect(isRetryableProviderStatus(undefined, "service unavailable")).toBe(true);
    expect(isRetryableProviderStatus(400, "timeout while connecting")).toBe(true);
    expect(isRetryableProviderStatus(400, "timed out after 30s")).toBe(true);
  });

  it("is case-insensitive for textual signals", () => {
    expect(isRetryableProviderStatus(undefined, "OVERLOADED")).toBe(true);
    expect(isRetryableProviderStatus(undefined, "Service Unavailable")).toBe(true);
  });

  it("returns false for benign messages without retry signals", () => {
    expect(isRetryableProviderStatus(undefined, "invalid api key")).toBe(false);
    expect(isRetryableProviderStatus(undefined, "")).toBe(false);
    expect(isRetryableProviderStatus(400, "bad request")).toBe(false);
  });
});

describe("parseProviderApiErrorText", () => {
  it("parses API Error with numeric status", () => {
    expect(parseProviderApiErrorText("API Error: 429 rate limited")).toEqual({
      statusCode: 429,
      message: "API Error: 429 rate limited",
    });
    expect(parseProviderApiErrorText("API Error: 500 internal")).toEqual({
      statusCode: 500,
      message: "API Error: 500 internal",
    });
  });

  it("parses the Failed to authenticate prefix", () => {
    const text = "Failed to authenticate. API Error: 401 unauthorized";
    expect(parseProviderApiErrorText(text)).toEqual({
      statusCode: 401,
      message: text,
    });
  });

  it("returns statusCode undefined for non-numeric envelopes", () => {
    expect(parseProviderApiErrorText("API Error: Request was aborted.")).toEqual({
      statusCode: undefined,
      message: "API Error: Request was aborted.",
    });
  });

  it("trims surrounding whitespace before matching", () => {
    expect(parseProviderApiErrorText("  API Error: 503 busy  ")).toEqual({
      statusCode: 503,
      message: "API Error: 503 busy",
    });
  });

  it("returns null for genuine prose that does not start with the envelope", () => {
    expect(parseProviderApiErrorText("The model says: API Error: 500 oops")).toBe(null);
    expect(parseProviderApiErrorText("hello world")).toBe(null);
    expect(parseProviderApiErrorText("")).toBe(null);
  });

  it("handles API Error without colon", () => {
    expect(parseProviderApiErrorText("API Error")).toEqual({
      statusCode: undefined,
      message: "API Error",
    });
  });
});

describe("isProviderApiErrorText", () => {
  it("returns true for API Error envelopes and false otherwise", () => {
    expect(isProviderApiErrorText("API Error: 429")).toBe(true);
    expect(isProviderApiErrorText("API Error: aborted")).toBe(true);
    expect(isProviderApiErrorText("hello")).toBe(false);
  });
});

describe("ProviderApiError", () => {
  it("derives retryable from status/message when not explicitly set", () => {
    const err = new ProviderApiError("overloaded", { statusCode: 200 });
    expect(err.retryable).toBe(true);
    expect(err.statusCode).toBe(200);
    expect(err.name).toBe("ProviderApiError");
  });

  it("respects an explicit retryable override", () => {
    const err = new ProviderApiError("ok", { statusCode: 429, retryable: false });
    expect(err.retryable).toBe(false);
  });

  it("classifies 429 as retryable via default", () => {
    const err = new ProviderApiError("rate limited", { statusCode: 429 });
    expect(err.retryable).toBe(true);
  });

  it("carries cause when provided", () => {
    const cause = new Error("root");
    const err = new ProviderApiError("wrapped", { cause });
    expect((err as Error & { cause: unknown }).cause).toBe(cause);
  });
});
