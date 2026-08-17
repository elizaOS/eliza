/**
 * Unit tests for subscription and OAuth authentication utilities in packages/shared/src/utils/subscription-auth.ts.
 * Exercises callback input normalization, raw code validation, localhost/127.0.0.1 port and path checks,
 * non-string handling, and error formatting.
 */
import { describe, expect, it } from "vitest";
import {
  formatSubscriptionRequestError,
  normalizeOpenAICallbackInput,
} from "./subscription-auth.js";

describe("subscription auth utilities", () => {
  describe("formatSubscriptionRequestError", () => {
    it("extracts message from Error instance", () => {
      expect(
        formatSubscriptionRequestError(new Error("Connection reset by peer")),
      ).toBe("Connection reset by peer");
    });

    it("stringifies non-Error values", () => {
      expect(formatSubscriptionRequestError("Internal Server Error")).toBe(
        "Internal Server Error",
      );
      expect(formatSubscriptionRequestError(500)).toBe("500");
    });
  });

  describe("normalizeOpenAICallbackInput", () => {
    it("returns error on non-string or empty inputs", () => {
      expect(normalizeOpenAICallbackInput(null)).toEqual({
        ok: false,
        error: "subscriptionstatus.PasteCallbackUrlFromLocalhost",
      });
      expect(normalizeOpenAICallbackInput(undefined)).toEqual({
        ok: false,
        error: "subscriptionstatus.PasteCallbackUrlFromLocalhost",
      });
      expect(normalizeOpenAICallbackInput("   ")).toEqual({
        ok: false,
        error: "subscriptionstatus.PasteCallbackUrlFromLocalhost",
      });
    });

    it("accepts valid raw authorization code", () => {
      expect(normalizeOpenAICallbackInput("oa_code_987654321")).toEqual({
        ok: true,
        code: "oa_code_987654321",
      });
    });

    it("rejects excessively long raw codes", () => {
      const longCode = "a".repeat(4097);
      expect(normalizeOpenAICallbackInput(longCode)).toEqual({
        ok: false,
        error: "subscriptionstatus.CallbackCodeTooLong",
      });
    });

    it("normalizes localhost and 127.0.0.1 callback URLs", () => {
      const fullUrl = "http://localhost:1455/auth/callback?code=secret_code_1";
      expect(normalizeOpenAICallbackInput(fullUrl)).toEqual({
        ok: true,
        code: fullUrl,
      });

      const schemaLessLocalhost =
        "localhost:1455/auth/callback?code=secret_code_2";
      expect(normalizeOpenAICallbackInput(schemaLessLocalhost)).toEqual({
        ok: true,
        code: "http://localhost:1455/auth/callback?code=secret_code_2",
      });

      const ipUrl = "http://127.0.0.1:1455/auth/callback?code=secret_code_3";
      expect(normalizeOpenAICallbackInput(ipUrl)).toEqual({
        ok: true,
        code: ipUrl,
      });
    });

    it("rejects URLs with incorrect host, port, or path", () => {
      expect(
        normalizeOpenAICallbackInput(
          "http://attacker.com:1455/auth/callback?code=123",
        ),
      ).toEqual({
        ok: false,
        error: "subscriptionstatus.ExpectedCallbackUrl",
      });

      expect(
        normalizeOpenAICallbackInput(
          "http://localhost:8080/auth/callback?code=123",
        ),
      ).toEqual({
        ok: false,
        error: "subscriptionstatus.ExpectedCallbackUrl",
      });

      expect(
        normalizeOpenAICallbackInput(
          "http://localhost:1455/other/callback?code=123",
        ),
      ).toEqual({
        ok: false,
        error: "subscriptionstatus.ExpectedCallbackUrl",
      });
    });

    it("rejects callback URLs missing code parameter", () => {
      expect(
        normalizeOpenAICallbackInput("http://localhost:1455/auth/callback"),
      ).toEqual({
        ok: false,
        error: "subscriptionstatus.CallbackUrlMissingCode",
      });
    });
  });
});
