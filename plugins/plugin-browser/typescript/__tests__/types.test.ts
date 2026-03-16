import { describe, expect, it } from "vitest";
import type {
  BrowserActionResult,
  BrowserConfig,
  BrowserSession,
  CaptchaResult,
  CaptchaType,
  ExtractResult,
  NavigationResult,
  RateLimitConfig,
  RetryConfig,
  ScreenshotResult,
  SecurityConfig,
  WebSocketMessage,
  WebSocketResponse,
} from "../src/types.js";
import { BROWSER_SERVICE_TYPE } from "../src/types.js";

describe("Browser Plugin Types", () => {
  describe("BROWSER_SERVICE_TYPE", () => {
    it("should be defined as 'browser'", () => {
      expect(BROWSER_SERVICE_TYPE).toBe("browser");
    });
  });

  describe("BrowserSession", () => {
    it("should create valid session object", () => {
      const session: BrowserSession = {
        id: "test-session-id",
        createdAt: new Date(),
        url: "https://example.com",
        title: "Example",
      };

      expect(session.id).toBe("test-session-id");
      expect(session.createdAt).toBeInstanceOf(Date);
      expect(session.url).toBe("https://example.com");
      expect(session.title).toBe("Example");
    });

    it("should allow optional url and title", () => {
      const session: BrowserSession = {
        id: "test-session-id",
        createdAt: new Date(),
      };

      expect(session.url).toBeUndefined();
      expect(session.title).toBeUndefined();
    });
  });

  describe("NavigationResult", () => {
    it("should create successful navigation result", () => {
      const result: NavigationResult = {
        success: true,
        url: "https://example.com",
        title: "Example Page",
      };

      expect(result.success).toBe(true);
      expect(result.url).toBe("https://example.com");
      expect(result.title).toBe("Example Page");
      expect(result.error).toBeUndefined();
    });

    it("should create failed navigation result", () => {
      const result: NavigationResult = {
        success: false,
        url: "",
        title: "",
        error: "Navigation failed",
      };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Navigation failed");
    });
  });

  describe("BrowserActionResult", () => {
    it("should create successful action result", () => {
      const result: BrowserActionResult = {
        success: true,
        data: { clicked: true },
      };

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ clicked: true });
    });
  });

  describe("ExtractResult", () => {
    it("should create successful extract result", () => {
      const result: ExtractResult = {
        success: true,
        found: true,
        data: "Extracted text",
      };

      expect(result.success).toBe(true);
      expect(result.found).toBe(true);
      expect(result.data).toBe("Extracted text");
    });
  });

  describe("ScreenshotResult", () => {
    it("should create successful screenshot result", () => {
      const result: ScreenshotResult = {
        success: true,
        data: "base64encodeddata",
        mimeType: "image/png",
        url: "https://example.com",
        title: "Example",
      };

      expect(result.success).toBe(true);
      expect(result.mimeType).toBe("image/png");
    });
  });

  describe("CaptchaResult", () => {
    it("should create captcha detection result", () => {
      const result: CaptchaResult = {
        detected: true,
        type: "recaptcha-v2",
        siteKey: "test-site-key",
        solved: false,
      };

      expect(result.detected).toBe(true);
      expect(result.type).toBe("recaptcha-v2");
      expect(result.solved).toBe(false);
    });
  });

  describe("CaptchaType", () => {
    it("should support all captcha types", () => {
      const types: CaptchaType[] = [
        "turnstile",
        "recaptcha-v2",
        "recaptcha-v3",
        "hcaptcha",
        "none",
      ];

      expect(types).toHaveLength(5);
    });
  });

  describe("SecurityConfig", () => {
    it("should create security config with defaults", () => {
      const config: SecurityConfig = {
        allowedDomains: ["example.com"],
        blockedDomains: ["malware.com"],
        maxUrlLength: 2048,
        allowLocalhost: true,
        allowFileProtocol: false,
      };

      expect(config.allowedDomains).toContain("example.com");
      expect(config.allowLocalhost).toBe(true);
    });
  });

  describe("RetryConfig", () => {
    it("should create retry config", () => {
      const config: RetryConfig = {
        maxAttempts: 3,
        initialDelayMs: 1000,
        maxDelayMs: 5000,
        backoffMultiplier: 2,
      };

      expect(config.maxAttempts).toBe(3);
      expect(config.backoffMultiplier).toBe(2);
    });
  });

  describe("BrowserConfig", () => {
    it("should create browser config", () => {
      const config: BrowserConfig = {
        headless: true,
        serverPort: 3456,
      };

      expect(config.headless).toBe(true);
      expect(config.serverPort).toBe(3456);
    });
  });

  describe("WebSocketMessage", () => {
    it("should create websocket message", () => {
      const message: WebSocketMessage = {
        type: "navigate",
        requestId: "req-123",
        sessionId: "sess-456",
        data: { url: "https://example.com" },
      };

      expect(message.type).toBe("navigate");
      expect(message.requestId).toBe("req-123");
    });
  });

  describe("WebSocketResponse", () => {
    it("should create websocket response", () => {
      const response: WebSocketResponse = {
        type: "navigate",
        requestId: "req-123",
        success: true,
        data: { url: "https://example.com", title: "Example" },
      };

      expect(response.success).toBe(true);
      expect(response.data).toBeDefined();
    });
  });

  describe("RateLimitConfig", () => {
    it("should create rate limit config", () => {
      const config: RateLimitConfig = {
        maxActionsPerMinute: 60,
        maxSessionsPerHour: 10,
      };

      expect(config.maxActionsPerMinute).toBe(60);
      expect(config.maxSessionsPerHour).toBe(10);
    });
  });
});
