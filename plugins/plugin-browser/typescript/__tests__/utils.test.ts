import { describe, expect, it } from "vitest";
import {
  ActionError,
  BrowserError,
  CaptchaError,
  NavigationError,
  NoUrlFoundError,
  SecurityError,
  ServiceNotAvailableError,
  SessionError,
  TimeoutError,
} from "../src/utils/errors.js";
import { DEFAULT_RETRY_CONFIGS, retryWithBackoff, sleep } from "../src/utils/retry.js";
import { InputSanitizer, UrlValidator } from "../src/utils/security.js";
import { extractUrl, parseClickTarget, parseExtractInstruction } from "../src/utils/url.js";

describe("Browser Plugin Utilities", () => {
  describe("Error Classes", () => {
    it("should create BrowserError with code", () => {
      const error = new BrowserError("Test error", "ACTION_ERROR", "User message", true);
      expect(error.message).toBe("Test error");
      expect(error.code).toBe("ACTION_ERROR");
      expect(error.name).toBe("BrowserError");
    });

    it("should create ServiceNotAvailableError", () => {
      const error = new ServiceNotAvailableError();
      expect(error.code).toBe("SERVICE_NOT_AVAILABLE");
    });

    it("should create SessionError", () => {
      const error = new SessionError("Session invalid");
      expect(error.code).toBe("SESSION_ERROR");
    });

    it("should create NavigationError", () => {
      const error = new NavigationError("https://example.com");
      expect(error.code).toBe("NAVIGATION_ERROR");
    });

    it("should create ActionError", () => {
      const error = new ActionError("click", "button");
      expect(error.code).toBe("ACTION_ERROR");
    });

    it("should create SecurityError", () => {
      const error = new SecurityError("Security violation");
      expect(error.code).toBe("SECURITY_ERROR");
    });

    it("should create CaptchaError", () => {
      const error = new CaptchaError("Captcha failed");
      expect(error.code).toBe("CAPTCHA_ERROR");
    });

    it("should create TimeoutError", () => {
      const error = new TimeoutError("operation", 5000);
      expect(error.code).toBe("TIMEOUT_ERROR");
    });

    it("should create NoUrlFoundError", () => {
      const error = new NoUrlFoundError();
      expect(error.code).toBe("NO_URL_FOUND");
    });
  });

  describe("URL Extraction", () => {
    it("should extract URL from text with https", () => {
      const result = extractUrl("Please navigate to https://example.com");
      expect(result).toBe("https://example.com");
    });

    it("should extract URL from text with http", () => {
      const result = extractUrl("Go to http://example.com/page");
      expect(result).toBe("http://example.com/page");
    });

    it("should return null for text without URL", () => {
      const result = extractUrl("No URL here");
      expect(result).toBeNull();
    });

    it("should extract first URL when multiple present", () => {
      const result = extractUrl("Check https://first.com and https://second.com");
      expect(result).toBe("https://first.com");
    });
  });

  describe("Click Target Parsing", () => {
    it("should parse click target from text", () => {
      const result = parseClickTarget("click the submit button");
      expect(result).toBeTruthy();
    });
  });

  describe("Extract Instruction Parsing", () => {
    it("should parse extract instruction", () => {
      const result = parseExtractInstruction("extract the main content from the page");
      expect(result).toBeTruthy();
    });
  });

  describe("UrlValidator", () => {
    it("should validate allowed URLs", () => {
      const validator = new UrlValidator({
        allowedDomains: ["example.com"],
        blockedDomains: [],
        maxUrlLength: 2048,
        allowLocalhost: false,
        allowFileProtocol: false,
      });

      const result = validator.validate("https://example.com/page");
      expect(result.valid).toBe(true);
    });

    it("should block blocked domains", () => {
      const validator = new UrlValidator({
        allowedDomains: [],
        blockedDomains: ["malware.com"],
        maxUrlLength: 2048,
        allowLocalhost: false,
        allowFileProtocol: false,
      });

      const result = validator.validate("https://malware.com/bad");
      expect(result.valid).toBe(false);
    });

    it("should respect allowLocalhost setting", () => {
      const validatorWithLocalhost = new UrlValidator({
        allowedDomains: [],
        blockedDomains: [],
        maxUrlLength: 2048,
        allowLocalhost: true,
        allowFileProtocol: false,
      });

      const result1 = validatorWithLocalhost.validate("http://localhost:3000");
      expect(result1.valid).toBe(true);

      const validatorWithoutLocalhost = new UrlValidator({
        allowedDomains: [],
        blockedDomains: [],
        maxUrlLength: 2048,
        allowLocalhost: false,
        allowFileProtocol: false,
      });

      const result2 = validatorWithoutLocalhost.validate("http://localhost:3000");
      expect(result2.valid).toBe(false);
    });

    it("should reject URLs exceeding max length", () => {
      const validator = new UrlValidator({
        allowedDomains: [],
        blockedDomains: [],
        maxUrlLength: 50,
        allowLocalhost: false,
        allowFileProtocol: false,
      });

      const longUrl = `https://example.com/${"a".repeat(100)}`;
      const result = validator.validate(longUrl);
      expect(result.valid).toBe(false);
    });
  });

  describe("InputSanitizer", () => {
    it("should sanitize text by removing dangerous characters", () => {
      const sanitized = InputSanitizer.sanitizeText("<script>alert('xss')</script>");
      expect(sanitized).not.toContain("<script>");
    });

    it("should trim whitespace", () => {
      const sanitized = InputSanitizer.sanitizeText("  hello world  ");
      expect(sanitized).toBe("hello world");
    });

    it("should sanitize selectors", () => {
      const sanitized = InputSanitizer.sanitizeSelector('#button<script>alert("test")</script>');
      expect(sanitized).not.toContain("<script>");
    });
  });

  describe("Retry Logic", () => {
    it("should have default retry configs", () => {
      expect(DEFAULT_RETRY_CONFIGS.navigation).toBeDefined();
      expect(DEFAULT_RETRY_CONFIGS.navigation.maxAttempts).toBeGreaterThan(0);
    });

    it("should sleep for specified duration", async () => {
      const start = Date.now();
      await sleep(50);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(45);
    });

    it("should retry on failure and succeed eventually", async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("Temporary failure");
        }
        return "success";
      };

      const result = await retryWithBackoff(fn, {
        maxAttempts: 5,
        initialDelayMs: 10,
        maxDelayMs: 50,
        backoffMultiplier: 1.5,
      });

      expect(result).toBe("success");
      expect(attempts).toBe(3);
    });

    it("should throw after max attempts exceeded", async () => {
      const fn = async () => {
        throw new Error("Permanent failure");
      };

      await expect(
        retryWithBackoff(fn, {
          maxAttempts: 2,
          initialDelayMs: 10,
          maxDelayMs: 50,
          backoffMultiplier: 1.5,
        })
      ).rejects.toThrow("Permanent failure");
    });
  });
});
