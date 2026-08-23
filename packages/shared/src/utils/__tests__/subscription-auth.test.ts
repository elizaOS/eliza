import { describe, expect, it } from "vitest";
import {
  formatSubscriptionRequestError,
  normalizeOpenAICallbackInput,
} from "./subscription-auth.ts";

describe("formatSubscriptionRequestError", () => {
  it("uses Error messages and stringifies other values", () => {
    expect(formatSubscriptionRequestError(new Error("boom"))).toBe("boom");
    expect(formatSubscriptionRequestError("plain")).toBe("plain");
    expect(formatSubscriptionRequestError(42)).toBe("42");
  });
});

describe("normalizeOpenAICallbackInput", () => {
  it("rejects missing or empty input", () => {
    expect(normalizeOpenAICallbackInput(null).ok).toBe(false);
    expect(normalizeOpenAICallbackInput(undefined).ok).toBe(false);
    expect(normalizeOpenAICallbackInput("").ok).toBe(false);
    expect(normalizeOpenAICallbackInput("   ").ok).toBe(false);
  });

  it("accepts bare codes with a length limit", () => {
    const ok = normalizeOpenAICallbackInput("abc123");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.code).toBe("abc123");

    const tooLong = normalizeOpenAICallbackInput("x".repeat(5000));
    expect(tooLong.ok).toBe(false);
  });

  it("normalizes localhost-prefixed callbacks to http", () => {
    const r = normalizeOpenAICallbackInput(
      "localhost:1455/auth/callback?code=xyz",
    );
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.code).toBe("http://localhost:1455/auth/callback?code=xyz");
  });

  it("accepts only localhost:1455/auth/callback URLs", () => {
    expect(
      normalizeOpenAICallbackInput("https://evil.com/auth/callback?code=x").ok,
    ).toBe(false);
    expect(
      normalizeOpenAICallbackInput("http://localhost:9999/auth/callback?code=x")
        .ok,
    ).toBe(false);
    expect(
      normalizeOpenAICallbackInput("http://localhost:1455/other?code=x").ok,
    ).toBe(false);
    expect(
      normalizeOpenAICallbackInput("http://localhost:1455/auth/callback").ok,
    ).toBe(false);
    expect(
      normalizeOpenAICallbackInput("http://127.0.0.1:1455/auth/callback?code=x")
        .ok,
    ).toBe(true);
  });
});
