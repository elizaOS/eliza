/**
 * Unit tests for subscription auth helpers in packages/shared/src/utils/subscription-auth.ts.
 * Exercises error formatting, OpenAI OAuth callback URL parsing, raw authorization
 * code handling, URL prefix normalization, validation rejections, and non-string inputs.
 */
import { describe, expect, it } from "vitest";
import {
  formatSubscriptionRequestError,
  normalizeOpenAICallbackInput,
} from "./subscription-auth.js";

describe("formatSubscriptionRequestError", () => {
  it("extracts message from Error instances", () => {
    expect(formatSubscriptionRequestError(new Error("auth failed"))).toBe(
      "auth failed",
    );
  });

  it("converts non-Error values to string", () => {
    expect(formatSubscriptionRequestError("custom error")).toBe("custom error");
    expect(formatSubscriptionRequestError(404)).toBe("404");
  });
});

describe("normalizeOpenAICallbackInput", () => {
  it("accepts valid full callback URLs from localhost and 127.0.0.1", () => {
    const res1 = normalizeOpenAICallbackInput(
      "http://localhost:1455/auth/callback?code=secret_code_123",
    );
    expect(res1).toEqual({
      ok: true,
      code: "http://localhost:1455/auth/callback?code=secret_code_123",
    });

    const res2 = normalizeOpenAICallbackInput(
      "http://127.0.0.1:1455/auth/callback?code=secret_code_456",
    );
    expect(res2).toEqual({
      ok: true,
      code: "http://127.0.0.1:1455/auth/callback?code=secret_code_456",
    });
  });

  it("normalizes localhost and 127.0.0.1 urls lacking the http scheme", () => {
    const res = normalizeOpenAICallbackInput(
      "localhost:1455/auth/callback?code=secret_code_789",
    );
    expect(res).toEqual({
      ok: true,
      code: "http://localhost:1455/auth/callback?code=secret_code_789",
    });
  });

  it("accepts raw authorization codes without URL scheme", () => {
    const res = normalizeOpenAICallbackInput("raw_auth_code_xyz");
    expect(res).toEqual({
      ok: true,
      code: "raw_auth_code_xyz",
    });
  });

  it("rejects excessively long raw codes", () => {
    const longCode = "a".repeat(4097);
    const res = normalizeOpenAICallbackInput(longCode);
    expect(res).toEqual({
      ok: false,
      error: "subscriptionstatus.CallbackCodeTooLong",
    });
  });

  it("rejects callback URLs with invalid host, port, or path", () => {
    expect(
      normalizeOpenAICallbackInput(
        "http://example.com:1455/auth/callback?code=abc",
      ),
    ).toEqual({
      ok: false,
      error: "subscriptionstatus.ExpectedCallbackUrl",
    });

    expect(
      normalizeOpenAICallbackInput(
        "http://localhost:8080/auth/callback?code=abc",
      ),
    ).toEqual({
      ok: false,
      error: "subscriptionstatus.ExpectedCallbackUrl",
    });

    expect(
      normalizeOpenAICallbackInput("http://localhost:1455/other?code=abc"),
    ).toEqual({
      ok: false,
      error: "subscriptionstatus.ExpectedCallbackUrl",
    });
  });

  it("rejects callback URLs missing code search parameter", () => {
    expect(
      normalizeOpenAICallbackInput("http://localhost:1455/auth/callback"),
    ).toEqual({
      ok: false,
      error: "subscriptionstatus.CallbackUrlMissingCode",
    });
  });

  it("rejects empty, null, undefined, or non-string inputs", () => {
    expect(normalizeOpenAICallbackInput("")).toEqual({
      ok: false,
      error: "subscriptionstatus.PasteCallbackUrlFromLocalhost",
    });
    expect(normalizeOpenAICallbackInput("   ")).toEqual({
      ok: false,
      error: "subscriptionstatus.PasteCallbackUrlFromLocalhost",
    });
    expect(normalizeOpenAICallbackInput(null)).toEqual({
      ok: false,
      error: "subscriptionstatus.PasteCallbackUrlFromLocalhost",
    });
    expect(normalizeOpenAICallbackInput(undefined)).toEqual({
      ok: false,
      error: "subscriptionstatus.PasteCallbackUrlFromLocalhost",
    });
    expect(normalizeOpenAICallbackInput(123 as unknown as string)).toEqual({
      ok: false,
      error: "subscriptionstatus.PasteCallbackUrlFromLocalhost",
    });
  });
});
