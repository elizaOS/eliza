/**
 * Exercises the API authentication token helpers with deterministic request headers.
 */

import { describe, expect, it } from "vitest";
import {
  extractHeaderValue,
  getProvidedApiToken,
  tokenMatches,
} from "../tokens.ts";

describe("tokenMatches", () => {
  it("matches equal tokens", () => {
    expect(tokenMatches("secret", "secret")).toBe(true);
  });

  it("rejects different tokens and different lengths", () => {
    expect(tokenMatches("secret", "secret2")).toBe(false);
    expect(tokenMatches("secret", "other")).toBe(false);
    expect(tokenMatches("a", "bb")).toBe(false);
  });
});

describe("extractHeaderValue", () => {
  it("passes through strings and first array entries", () => {
    expect(extractHeaderValue("x")).toBe("x");
    expect(extractHeaderValue(["a", "b"])).toBe("a");
    expect(extractHeaderValue(undefined)).toBeNull();
    expect(extractHeaderValue([])).toBeNull();
  });
});

describe("getProvidedApiToken", () => {
  it("parses the Bearer authorization header", () => {
    const req = { headers: { authorization: "Bearer abc123" } } as never;
    expect(getProvidedApiToken(req)).toBe("abc123");
  });

  it("falls back to the x-eliza-token header", () => {
    const req = { headers: { "x-eliza-token": "tok-1" } } as never;
    expect(getProvidedApiToken(req)).toBe("tok-1");
  });

  it("falls back to x-api-key and returns null when absent", () => {
    const req = { headers: { "x-api-key": "k" } } as never;
    expect(getProvidedApiToken(req)).toBe("k");
    expect(getProvidedApiToken({ headers: {} } as never)).toBeNull();
  });
});
