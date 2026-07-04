// Exercises errors behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "vitest";
import { getErrorStatusCode, getSafeErrorMessage } from "./errors";

/**
 * API error mapping. getErrorStatusCode classifies errors to HTTP status by
 * name/message; getSafeErrorMessage must NEVER leak DB/connection internals to
 * the client (returns a generic message) while passing safe client-error text
 * through — a leak here exposes backend topology.
 */

const named = (name: string, message = "x"): Error => {
  const e = new Error(message);
  e.name = name;
  return e;
};

describe("getErrorStatusCode", () => {
  test("maps by error name", () => {
    expect(getErrorStatusCode(named("NotFoundError"))).toBe(404);
    expect(getErrorStatusCode(named("RateLimitError"))).toBe(429);
    expect(getErrorStatusCode(named("ForbiddenError"))).toBe(403);
    expect(getErrorStatusCode(named("AuthenticationError"))).toBe(401);
  });

  test("maps by message phrase, defaults to 500", () => {
    expect(getErrorStatusCode(new Error("Invalid API key"))).toBe(401);
    expect(getErrorStatusCode(new Error("access denied for user"))).toBe(403);
    expect(getErrorStatusCode(new Error("resource not found"))).toBe(404);
    expect(getErrorStatusCode(new Error("rate limit hit"))).toBe(429);
    // DB auth failure must stay 500, not 401.
    expect(getErrorStatusCode(new Error("password authentication failed"))).toBe(500);
    expect(getErrorStatusCode(new Error("something random"))).toBe(500);
    expect(getErrorStatusCode("not an error")).toBe(500);
  });
});

describe("getSafeErrorMessage", () => {
  test("redacts backend/DB internals", () => {
    expect(getSafeErrorMessage(new Error("connection refused to postgres"))).toBe(
      "An unexpected error occurred",
    );
    expect(getSafeErrorMessage(new Error("getaddrinfo ENOTFOUND db.host"))).toBe(
      "An unexpected error occurred",
    );
    expect(getSafeErrorMessage(new Error("internal explosion at line 42"))).toBe(
      "An unexpected error occurred",
    );
    expect(getSafeErrorMessage("plain string")).toBe("An unexpected error occurred");
  });

  test("passes safe client-error messages through", () => {
    expect(getSafeErrorMessage(new Error("User not found"))).toBe("User not found");
    expect(getSafeErrorMessage(new Error("Rate limit exceeded"))).toBe("Rate limit exceeded");
  });
});
