/**
 * Unit coverage for defaultPrivacyRedactor — credential, geo, and env-secret
 * redaction over the tool-call cache write path.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultPrivacyRedactor,
  isRedactionDegraded,
  REDACT_BUDGET_SENTINEL,
} from "./redact.ts";

const ORIG_ENV = { ...process.env };

describe("defaultPrivacyRedactor", () => {
  beforeEach(() => {
    process.env = { ...ORIG_ENV };
    delete process.env.MY_API_KEY;
    delete process.env.MY_TOKEN;
    delete process.env.ELIZA_API_TOKEN;
  });

  afterEach(() => {
    process.env = { ...ORIG_ENV };
  });

  it("redacts an OpenAI-style key", () => {
    const out = defaultPrivacyRedactor(
      "using key sk-abcdefghijklmnop1234567890",
    ) as string;
    expect(out).toContain("<REDACTED:openai-key>");
    expect(out).not.toContain("sk-abcdefghijklmnop");
  });

  it("redacts an Anthropic-style key", () => {
    const out = defaultPrivacyRedactor(
      "auth sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456",
    ) as string;
    expect(out).not.toContain("sk-ant-api03");
    expect(out).toContain("<REDACTED:anthropic-key>");
  });

  it("redacts a Bearer token", () => {
    const out = defaultPrivacyRedactor(
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
    ) as string;
    expect(out).not.toContain("Bearer abcdefghijklmnopqrstuvwxyz123456");
    expect(out).toContain("<REDACTED:bearer>");
  });

  it("redacts a GitHub token", () => {
    const out = defaultPrivacyRedactor(
      "token ghp_1234567890abcdefghijklmnopqrst",
    ) as string;
    expect(out).not.toContain("ghp_1234567890");
    expect(out).toContain("<REDACTED:github-token>");
  });

  it("redacts an AWS access key", () => {
    const out = defaultPrivacyRedactor("key AKIAIOSFODNN7EXAMPLE") as string;
    expect(out).not.toContain("AKIAIOSFODNN7");
    expect(out).toContain("<REDACTED:aws-access-key>");
  });

  it("redacts geographic coordinates (JSON coords object)", () => {
    const out = defaultPrivacyRedactor(
      '{"coords":{"latitude":37.7749,"longitude":-122.4194}}',
    ) as string;
    expect(out).toContain("[REDACTED_GEO]");
    expect(out).not.toContain("37.7749");
  });

  it("redacts coordinate objects with additional scalar fields", () => {
    const out = defaultPrivacyRedactor(
      '{"coords" : { "latitude" : 37.7749, "longitude" : -122.4194, "accuracy" : 12, "source_name": "gps" }}',
    ) as string;
    expect(out).toBe("{[REDACTED_GEO]}");
  });

  it("scans adversarial coordinate-like text in linear time", () => {
    const input = `{"coords":{"latitude":0,"longitude":0${',"A":+\t'.repeat(50_000)}}}`;
    expect(defaultPrivacyRedactor(input)).toBe("{[REDACTED_GEO]}");
  });

  it("scans many overlapping malformed coordinate candidates in linear time", () => {
    // Every "coords" marker starts a candidate whose scan runs to the end of
    // the unterminated input; a non-monotonic cursor would rescan each
    // remaining suffix and go quadratic.
    const input = '"coords":{"latitude":0,"longitude":0,'.repeat(50_000);
    const out = defaultPrivacyRedactor(input) as string;
    expect(out).toContain("[REDACTED_GEO]");
    expect(out).not.toContain('"latitude":0');
  });

  it("still redacts a valid coords block after malformed candidates", () => {
    const out = defaultPrivacyRedactor(
      '"coords": nope, "coords" {}, {"coords":{"latitude":1.5,"longitude":2.5}}',
    ) as string;
    expect(out).toContain("{[REDACTED_GEO]}");
    expect(out).not.toContain("1.5");
  });

  it("redacts lat/lng pair", () => {
    const out = defaultPrivacyRedactor(
      '{"latitude": 48.8566, "longitude": 2.3522}',
    ) as string;
    expect(out).toContain("[REDACTED_GEO]");
    expect(out).not.toContain("48.8566");
    expect(out).not.toContain("2.3522");
  });

  it("redacts env secret values by name", () => {
    process.env.MY_API_KEY = "super-secret-value-12345";
    const out = defaultPrivacyRedactor(
      "the value is super-secret-value-12345",
    ) as string;
    expect(out).toContain("<REDACTED:env-secret>");
    expect(out).not.toContain("super-secret-value-12345");
  });

  it("recurses into nested objects and arrays", () => {
    const out = defaultPrivacyRedactor({
      a: { b: ["plain", "key sk-abcdefghijklmnop1234567890"] },
      c: { d: "lat 37.7749, -122.4194" },
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain("sk-abcdefghijklmnop");
    expect(JSON.stringify(out)).toContain("[REDACTED_GEO]");
  });

  it("leaves plain values untouched", () => {
    const out = defaultPrivacyRedactor(
      "hello world, no secrets here",
    ) as string;
    expect(out).toBe("hello world, no secrets here");
  });

  it("handles non-string primitives", () => {
    expect(defaultPrivacyRedactor(42)).toBe(42);
    expect(defaultPrivacyRedactor(true)).toBe(true);
    expect(defaultPrivacyRedactor(null)).toBe(null);
    expect(defaultPrivacyRedactor(undefined)).toBe(undefined);
  });

  it("bounds a flat-wide object instead of redacting every key", () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 150_000; i += 1) wide[`k${i}`] = i;
    const out = defaultPrivacyRedactor(wide);
    expect(out).toBe(REDACT_BUDGET_SENTINEL);
    expect(isRedactionDegraded(out)).toBe(true);
  });

  it("marks an accessor property degraded without invoking the getter", () => {
    let getterCalls = 0;
    const value: Record<string, unknown> = { ok: "plain" };
    Object.defineProperty(value, "leak", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return "secret";
      },
    });
    const out = defaultPrivacyRedactor(value) as Record<string, unknown>;
    expect(getterCalls).toBe(0);
    expect(out.ok).toBe("plain");
    expect(out.leak).toBe(REDACT_BUDGET_SENTINEL);
    expect(isRedactionDegraded(out)).toBe(true);
  });

  it("marks a revoked proxy degraded instead of throwing", () => {
    const revocable = Proxy.revocable({ payload: "value" }, {});
    revocable.revoke();
    let out: unknown;
    expect(() => {
      out = defaultPrivacyRedactor({ nested: revocable.proxy });
    }).not.toThrow();
    expect((out as Record<string, unknown>).nested).toBe(
      REDACT_BUDGET_SENTINEL,
    );
    expect(isRedactionDegraded(out)).toBe(true);
  });

  it("bounds an oversize string leaf", () => {
    const huge = "a".repeat(4_000_001);
    expect(defaultPrivacyRedactor({ blob: huge })).toEqual({
      blob: REDACT_BUDGET_SENTINEL,
    });
  });

  it("does not treat short strings as env secrets", () => {
    process.env.MY_API_KEY = "short";
    const out = defaultPrivacyRedactor("the value is short") as string;
    expect(out).toBe("the value is short");
  });
});
