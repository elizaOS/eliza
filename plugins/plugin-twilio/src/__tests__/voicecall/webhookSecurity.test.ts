import { describe, it, expect } from "vitest";
import {
  timingSafeEqual,
  isValidHostHeader,
  isTrustedProxy,
  reconstructWebhookUrl,
  computeTwilioSignature,
  validateTwilioSignature,
} from "../../voicecall/webhook-security";

describe("Webhook Security", () => {
  describe("timingSafeEqual", () => {
    it("should return true for equal strings", () => {
      expect(timingSafeEqual("abc", "abc")).toBe(true);
      expect(timingSafeEqual("", "")).toBe(true);
    });

    it("should return false for different strings", () => {
      expect(timingSafeEqual("abc", "def")).toBe(false);
      expect(timingSafeEqual("abc", "abcd")).toBe(false);
      expect(timingSafeEqual("abc", "ab")).toBe(false);
    });
  });

  describe("isValidHostHeader", () => {
    it("should accept valid host headers", () => {
      expect(isValidHostHeader("example.com")).toBe(true);
      expect(isValidHostHeader("example.com:3000")).toBe(true);
      expect(isValidHostHeader("sub.example.com")).toBe(true);
      expect(isValidHostHeader("localhost")).toBe(true);
    });

    it("should reject invalid host headers", () => {
      expect(isValidHostHeader(undefined)).toBe(false);
      expect(isValidHostHeader("")).toBe(false);
      expect(isValidHostHeader("example.com/path")).toBe(false);
      expect(isValidHostHeader("example.com?query")).toBe(false);
    });
  });

  describe("isTrustedProxy", () => {
    it("should return true for trusted IPs", () => {
      expect(isTrustedProxy("10.0.0.1", ["10.0.0.1"])).toBe(true);
      expect(isTrustedProxy("::ffff:10.0.0.1", ["10.0.0.1"])).toBe(true);
    });

    it("should return false for untrusted IPs", () => {
      expect(isTrustedProxy("10.0.0.2", ["10.0.0.1"])).toBe(false);
    });

    it("should return false when no trusted IPs configured", () => {
      expect(isTrustedProxy("10.0.0.1", undefined)).toBe(false);
      expect(isTrustedProxy("10.0.0.1", [])).toBe(false);
    });

    it("should return false when remote address is missing", () => {
      expect(isTrustedProxy(undefined, ["10.0.0.1"])).toBe(false);
    });
  });

  describe("reconstructWebhookUrl", () => {
    it("should use forwarded headers when trusted", () => {
      const url = reconstructWebhookUrl({
        requestUrl: "/voice/webhook",
        forwardedProto: "https",
        forwardedHost: "my-server.com",
        security: { trustForwardingHeaders: true },
      });

      expect(url).toBe("https://my-server.com/voice/webhook");
    });

    it("should use fallback URL when forwarding is not trusted", () => {
      const url = reconstructWebhookUrl({
        requestUrl: "/voice/webhook",
        fallbackUrl: "https://fallback.com",
      });

      expect(url).toBe("https://fallback.com/voice/webhook");
    });

    it("should use Host header as last resort", () => {
      const url = reconstructWebhookUrl({
        requestUrl: "/voice/webhook",
        hostHeader: "localhost:3334",
      });

      expect(url).toBe("http://localhost:3334/voice/webhook");
    });

    it("should fall back to localhost when nothing else available", () => {
      const url = reconstructWebhookUrl({
        requestUrl: "/voice/webhook",
      });

      expect(url).toBe("http://localhost/voice/webhook");
    });
  });

  describe("computeTwilioSignature", () => {
    it("should compute a consistent signature", () => {
      const sig1 = computeTwilioSignature("token123", "https://example.com/webhook", { a: "1" });
      const sig2 = computeTwilioSignature("token123", "https://example.com/webhook", { a: "1" });

      expect(sig1).toBe(sig2);
    });

    it("should produce different signatures for different tokens", () => {
      const sig1 = computeTwilioSignature("token1", "https://example.com", {});
      const sig2 = computeTwilioSignature("token2", "https://example.com", {});

      expect(sig1).not.toBe(sig2);
    });

    it("should sort parameters when computing signature", () => {
      const sig1 = computeTwilioSignature("token", "https://example.com", { b: "2", a: "1" });
      const sig2 = computeTwilioSignature("token", "https://example.com", { a: "1", b: "2" });

      expect(sig1).toBe(sig2);
    });
  });

  describe("validateTwilioSignature", () => {
    it("should validate correct signatures", () => {
      const authToken = "myAuthToken123";
      const url = "https://example.com/webhook";
      const params = { key: "value" };

      const signature = computeTwilioSignature(authToken, url, params);
      expect(validateTwilioSignature(authToken, url, params, signature)).toBe(true);
    });

    it("should reject incorrect signatures", () => {
      expect(
        validateTwilioSignature("token", "https://example.com", {}, "bad-sig"),
      ).toBe(false);
    });
  });
});
