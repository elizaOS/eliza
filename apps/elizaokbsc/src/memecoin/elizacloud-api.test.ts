import { describe, expect, test } from "bun:test";
import {
  elizaCloudAuthHeaders,
  looksLikeJwt,
  parseCreditsBalancePayload,
  parseCreditsSummaryPayload,
} from "./elizacloud-api";

describe("looksLikeJwt", () => {
  test("returns true for three non-empty dot segments", () => {
    expect(looksLikeJwt("a.b.c")).toBe(true);
    expect(looksLikeJwt("eyJhbGci.a.b")).toBe(true);
  });

  test("returns false for opaque API key-like strings", () => {
    expect(looksLikeJwt("")).toBe(false);
    expect(looksLikeJwt("sk_live_abc")).toBe(false);
    expect(looksLikeJwt("no-dots-here")).toBe(false);
    expect(looksLikeJwt("a.b")).toBe(false);
    expect(looksLikeJwt("a..c")).toBe(false);
  });
});

describe("elizaCloudAuthHeaders", () => {
  test("JWT-shaped credential gets Bearer only", () => {
    const token = "aaa.bbb.ccc";
    const h = elizaCloudAuthHeaders(token);
    expect(h.authorization).toBe(`Bearer ${token}`);
    expect(h["x-api-key"]).toBeUndefined();
    expect(h.accept).toBe("application/json");
  });

  test("non-JWT credential gets Bearer and x-api-key", () => {
    const key = "eliza_live_0123456789abcdef";
    const h = elizaCloudAuthHeaders(key);
    expect(h.authorization).toBe(`Bearer ${key}`);
    expect(h["x-api-key"]).toBe(key);
  });
});

describe("parseCreditsBalancePayload", () => {
  test("parses top-level balance including zero", () => {
    expect(parseCreditsBalancePayload({ balance: 0 })).toBe("0");
    expect(parseCreditsBalancePayload({ balance: 12.5 })).toBe("12.5");
    expect(parseCreditsBalancePayload({ balance: "12.5" })).toBe("12.5");
  });

  test("parses nested data.balance", () => {
    expect(parseCreditsBalancePayload({ data: { balance: 1 } })).toBe("1");
  });

  test("returns null for invalid or missing", () => {
    expect(parseCreditsBalancePayload(null)).toBe(null);
    expect(parseCreditsBalancePayload({})).toBe(null);
    expect(parseCreditsBalancePayload({ balance: "x" })).toBe(null);
    expect(parseCreditsBalancePayload({ balance: Number.NaN })).toBe(null);
  });
});

describe("parseCreditsSummaryPayload", () => {
  test("reads camelCase organization fields", () => {
    expect(
      parseCreditsSummaryPayload({
        success: true,
        organization: { name: "Acme", creditBalance: 50 },
      }),
    ).toEqual({
      displayName: "Acme",
      organizationName: "Acme",
      credits: "50",
    });
  });

  test("falls back to credit_balance snake_case", () => {
    expect(
      parseCreditsSummaryPayload({
        organization: { name: "Org", credit_balance: 42 },
      }),
    ).toEqual({
      displayName: "Org",
      organizationName: "Org",
      credits: "42",
    });
  });

  test("returns null without organization object", () => {
    expect(parseCreditsSummaryPayload({ success: true })).toBe(null);
  });
});
