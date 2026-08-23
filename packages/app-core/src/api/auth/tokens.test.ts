/**
 * Tests the API-auth token helpers in `tokens.ts`: constant-time `tokenMatches`,
 * multi-valued header normalisation in `extractHeaderValue`, and
 * `getProvidedApiToken` source order (Bearer, then x-eliza-token,
 * x-elizaos-token, x-api-key, x-api-token) including the 1024-char
 * Authorization cap. Drives the real module — no crypto or header mocks.
 */
import type http from "node:http";
import { describe, expect, it } from "vitest";
import {
  extractHeaderValue,
  getProvidedApiToken,
  tokenMatches,
} from "./tokens";

/**
 * Node types `IncomingHttpHeaders.authorization` as `string`, but duplicate
 * headers arrive as `string[]` at runtime. The helpers under test accept that
 * runtime bag; this wrapper is the test-side boundary.
 */
function incoming(
  headers: Record<string, string | string[] | undefined>,
): Pick<http.IncomingMessage, "headers"> {
  return { headers: headers as http.IncomingHttpHeaders };
}

describe("tokenMatches", () => {
  it("accepts identical strings, including empty and multi-byte UTF-8", () => {
    expect(tokenMatches("secret-token", "secret-token")).toBe(true);
    expect(tokenMatches("", "")).toBe(true);
    expect(tokenMatches("🔐 café", "🔐 café")).toBe(true);
  });

  it("rejects same-length mismatches, including case", () => {
    expect(tokenMatches("secret-token", "secret-t0ken")).toBe(false);
    expect(tokenMatches("Token", "token")).toBe(false);
  });

  it("rejects length mismatches even when one string prefixes the other", () => {
    expect(tokenMatches("secret", "secret1")).toBe(false);
    expect(tokenMatches("secret1", "secret")).toBe(false);
    expect(tokenMatches("", "x")).toBe(false);
    expect(tokenMatches("x", "")).toBe(false);
    expect(tokenMatches("ab", "ab\0")).toBe(false);
  });

  it("compares UTF-8 bytes, so NFC and NFD encodings of the same glyph differ", () => {
    expect(tokenMatches("é", "\u00e9")).toBe(true);
    expect(tokenMatches("é", "e\u0301")).toBe(false);
  });
});

describe("extractHeaderValue", () => {
  it("returns a present string as-is, including empty", () => {
    expect(extractHeaderValue("Bearer abc")).toBe("Bearer abc");
    expect(extractHeaderValue("")).toBe("");
  });

  it("returns the first string of a multi-valued header and ignores the rest", () => {
    expect(extractHeaderValue(["first", "second"])).toBe("first");
    expect(extractHeaderValue([""])).toBe("");
  });

  it("returns null when the header is absent, not an array of strings, or an empty array", () => {
    expect(extractHeaderValue(undefined)).toBeNull();
    expect(extractHeaderValue([])).toBeNull();
    expect(extractHeaderValue([undefined as unknown as string])).toBeNull();
  });
});

describe("getProvidedApiToken", () => {
  it("reads a Bearer token from Authorization, case-insensitively, and trims it", () => {
    expect(
      getProvidedApiToken(incoming({ authorization: "Bearer   tok-value  " })),
    ).toBe("tok-value");
    expect(
      getProvidedApiToken(incoming({ authorization: "bearer tok-value" })),
    ).toBe("tok-value");
    expect(
      getProvidedApiToken(incoming({ authorization: "BEARER tok-value" })),
    ).toBe("tok-value");
  });

  it("accepts one to eight separator whitespace chars after Bearer, including extras that trim off", () => {
    expect(getProvidedApiToken(incoming({ authorization: "Bearer tok" }))).toBe(
      "tok",
    );
    expect(
      getProvidedApiToken(
        incoming({ authorization: `Bearer${" ".repeat(8)}tok` }),
      ),
    ).toBe("tok");
    // Observed: \s{1,8} consumes eight spaces; leftover spaces are captured and trimmed.
    expect(
      getProvidedApiToken(
        incoming({ authorization: `Bearer${" ".repeat(9)}tok` }),
      ),
    ).toBe("tok");
  });

  it("does not treat a scheme without a token, or a non-Bearer scheme, as a provided token", () => {
    expect(
      getProvidedApiToken(incoming({ authorization: "Bearer" })),
    ).toBeNull();
    expect(
      getProvidedApiToken(incoming({ authorization: "Basic abc" })),
    ).toBeNull();
    expect(
      getProvidedApiToken(incoming({ authorization: "Bearertok" })),
    ).toBeNull();
  });

  it("caps Authorization at 1024 characters before parsing Bearer", () => {
    const token = "a".repeat(2000);
    const authorization = `Bearer ${token}`;
    const truncated = authorization.slice(0, 1024);
    expect(getProvidedApiToken(incoming({ authorization }))).toBe(
      truncated.slice("Bearer ".length),
    );
    expect(getProvidedApiToken(incoming({ authorization }))?.length).toBe(
      1024 - "Bearer ".length,
    );
  });

  it("prefers a valid Bearer token over the x-eliza-* / x-api-* headers", () => {
    expect(
      getProvidedApiToken(
        incoming({
          authorization: "Bearer from-bearer",
          "x-eliza-token": "from-eliza",
          "x-elizaos-token": "from-elizaos",
          "x-api-key": "from-key",
          "x-api-token": "from-api-token",
        }),
      ),
    ).toBe("from-bearer");
  });

  it("walks x-eliza-token, then x-elizaos-token, then x-api-key, then x-api-token", () => {
    expect(
      getProvidedApiToken(
        incoming({
          "x-eliza-token": "from-eliza",
          "x-elizaos-token": "from-elizaos",
          "x-api-key": "from-key",
          "x-api-token": "from-api-token",
        }),
      ),
    ).toBe("from-eliza");
    expect(
      getProvidedApiToken(
        incoming({
          "x-elizaos-token": "from-elizaos",
          "x-api-key": "from-key",
          "x-api-token": "from-api-token",
        }),
      ),
    ).toBe("from-elizaos");
    expect(
      getProvidedApiToken(
        incoming({
          "x-api-key": "from-key",
          "x-api-token": "from-api-token",
        }),
      ),
    ).toBe("from-key");
    expect(
      getProvidedApiToken(incoming({ "x-api-token": "from-api-token" })),
    ).toBe("from-api-token");
  });

  it("falls through to later headers when Bearer is present but not a usable token", () => {
    expect(
      getProvidedApiToken(
        incoming({
          authorization: "Basic abc",
          "x-eliza-token": "from-eliza",
        }),
      ),
    ).toBe("from-eliza");
  });

  it("trims fallback header tokens; a present empty/whitespace value does not fall through", () => {
    expect(
      getProvidedApiToken(incoming({ "x-eliza-token": "  padded  " })),
    ).toBe("padded");
    // Observed: ?? only skips null/undefined. A present blank string wins, then trim → null.
    expect(
      getProvidedApiToken(
        incoming({
          "x-eliza-token": "   ",
          "x-api-key": "from-key",
        }),
      ),
    ).toBeNull();
    expect(
      getProvidedApiToken(
        incoming({ "x-eliza-token": "", "x-api-key": "from-key" }),
      ),
    ).toBeNull();
  });

  it("continues the fallback chain when an earlier header is absent or an empty array", () => {
    expect(
      getProvidedApiToken(
        incoming({
          "x-eliza-token": [],
          "x-api-key": "from-key",
        }),
      ),
    ).toBe("from-key");
  });

  it("reads the first value when Authorization or fallback headers are arrays", () => {
    expect(
      getProvidedApiToken(
        incoming({
          authorization: ["Bearer array-bearer", "Bearer other"],
        }),
      ),
    ).toBe("array-bearer");
    expect(
      getProvidedApiToken(
        incoming({ "x-api-key": ["array-key", "other-key"] }),
      ),
    ).toBe("array-key");
  });

  it("returns null when no recognized header supplies a token", () => {
    expect(getProvidedApiToken(incoming({}))).toBeNull();
    expect(
      getProvidedApiToken(incoming({ "x-other-token": "ignored" })),
    ).toBeNull();
  });
});
