import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { classifyRetryError } from "../index";

function makeAPICallError(overrides: {
  statusCode?: number;
  isRetryable?: boolean;
  message?: string;
}): APICallError {
  return new APICallError({
    message: overrides.message ?? "error",
    url: "https://api.groq.com/v1/test",
    requestBodyValues: {},
    statusCode: overrides.statusCode,
    isRetryable: overrides.isRetryable,
  });
}

describe("classifyRetryError", () => {
  it("classifies 429 APICallError as rate-limit", () => {
    const err = makeAPICallError({ statusCode: 429, isRetryable: true });
    expect(classifyRetryError(err)).toBe("rate-limit");
  });

  it("classifies 5xx APICallError as transient", () => {
    for (const statusCode of [500, 502, 503, 504]) {
      expect(classifyRetryError(makeAPICallError({ statusCode }))).toBe("transient");
    }
  });

  it("classifies 4xx APICallError (non-429) as fatal", () => {
    expect(classifyRetryError(makeAPICallError({ statusCode: 401, isRetryable: false }))).toBe(
      "fatal"
    );
    expect(classifyRetryError(makeAPICallError({ statusCode: 400, isRetryable: false }))).toBe(
      "fatal"
    );
  });

  it("respects isRetryable when no status code signal applies", () => {
    expect(classifyRetryError(makeAPICallError({ isRetryable: true }))).toBe("transient");
  });

  it("classifies plain rate limit messages as rate-limit", () => {
    const messages = [
      "Rate limit reached for model. Please try again in 12.3s.",
      "rate_limit_exceeded",
      "429 Too Many Requests",
      "Try again in 30s",
    ];
    for (const message of messages) {
      expect(classifyRetryError(new Error(message))).toBe("rate-limit");
    }
  });

  it("classifies node fetch/undici network errors as transient", () => {
    const messages = [
      "connect ECONNRESET 1.2.3.4:443",
      "request to ... failed, reason: ETIMEDOUT",
      "getaddrinfo ENOTFOUND api.groq.com",
      "connect ECONNREFUSED 1.2.3.4:443",
      "socket hang up",
      "TypeError: fetch failed",
    ];
    for (const message of messages) {
      expect(classifyRetryError(new Error(message))).toBe("transient");
    }
  });

  it("classifies unknown Error messages as fatal", () => {
    expect(classifyRetryError(new Error("invalid prompt structure"))).toBe("fatal");
  });

  it("classifies non-Error throws as fatal", () => {
    expect(classifyRetryError("string reject")).toBe("fatal");
    expect(classifyRetryError(null)).toBe("fatal");
    expect(classifyRetryError(undefined)).toBe("fatal");
    expect(classifyRetryError({ message: "not an error" })).toBe("fatal");
  });
});
