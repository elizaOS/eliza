import { describe, it, expect, beforeEach, vi } from "vitest";
import { MessageHandler, Message } from "../src/message-handler.js";
import type { SessionManager, BrowserSession } from "../src/session-manager.js";
import type { Logger } from "../src/logger.js";
import type { ObservabilityManager } from "../src/observability-manager.js";

// All message types that should be handled
const ALL_MESSAGE_TYPES = [
  // Core session & health
  "health",
  "createSession",
  "destroySession",

  // Navigation
  "navigate",
  "goBack",
  "goForward",
  "refresh",

  // Multi-tab
  "listTabs",
  "createTab",
  "switchTab",
  "closeTab",

  // AI-powered actions
  "click",
  "type",
  "select",
  "extract",
  "observe",

  // Direct Playwright locator
  "querySelector",
  "querySelectorAll",
  "clickSelector",
  "fillSelector",
  "hoverSelector",

  // Wait operations
  "waitForSelector",
  "waitForUrl",
  "waitForLoadState",
  "waitForTimeout",

  // JavaScript evaluation
  "evaluate",

  // Screenshots & PDF
  "screenshot",
  "exportPdf",

  // Observability
  "getConsole",
  "getErrors",
  "getNetwork",
  "getObservabilityStats",

  // Storage
  "getCookies",
  "setCookies",
  "clearCookies",
  "getLocalStorage",
  "setLocalStorage",
  "clearLocalStorage",
  "getSessionStorage",
  "setSessionStorage",

  // Environment
  "setViewport",
  "setGeolocation",
  "setOffline",
  "emulateMedia",

  // Files & dialogs
  "uploadFile",
  "handleDialog",
  "getDialogs",

  // Downloads
  "getDownloads",

  // State & misc
  "getState",
  "solveCaptcha",

  // Otto parity features
  "startTrace",
  "stopTrace",
  "emulateDevice",
  "setLocale",
  "setTimezone",
  "setExtraHeaders",
  "setHttpCredentials",
  "press",
  "getFrames",
  "executeInFrame",
  "getResponseBody",
  "highlight",
] as const;

// Create mock logger
function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

// Create mock observability manager
function createMockObservabilityManager(): ObservabilityManager {
  return {
    attachToPage: vi.fn(),
    getConsoleMessages: vi.fn(() => []),
    getPageErrors: vi.fn(() => []),
    getNetworkRequests: vi.fn(() => []),
    getStats: vi.fn(() => ({ consoleCount: 0, errorCount: 0, networkCount: 0 })),
    clearAll: vi.fn(),
  } as unknown as ObservabilityManager;
}

// Create mock page
function createMockPage() {
  const mockFrame = {
    name: vi.fn(() => "main"),
    url: vi.fn(() => "https://example.com"),
    evaluate: vi.fn().mockResolvedValue({}),
  };

  const mockContext = {
    newCDPSession: vi.fn().mockResolvedValue({
      send: vi.fn().mockResolvedValue(undefined),
    }),
    setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
  };

  return {
    goto: vi.fn().mockResolvedValue(undefined),
    goBack: vi.fn().mockResolvedValue(undefined),
    goForward: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    waitForURL: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForResponse: vi.fn().mockResolvedValue({
      url: vi.fn(() => "https://api.example.com/data"),
      status: vi.fn(() => 200),
      text: vi.fn().mockResolvedValue("response body"),
    }),
    title: vi.fn().mockResolvedValue("Test Page"),
    url: vi.fn(() => "https://example.com"),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-screenshot")),
    pdf: vi.fn().mockResolvedValue(Buffer.from("fake-pdf")),
    $: vi.fn().mockResolvedValue(null),
    $$: vi.fn().mockResolvedValue([]),
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    hover: vi.fn().mockResolvedValue(undefined),
    setViewportSize: vi.fn().mockResolvedValue(undefined),
    emulateMedia: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue({}),
    on: vi.fn(),
    bringToFront: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    keyboard: {
      press: vi.fn().mockResolvedValue(undefined),
    },
    frames: vi.fn(() => [mockFrame]),
    mainFrame: vi.fn(() => mockFrame),
    context: vi.fn(() => mockContext),
  };
}

// Create mock context
function createMockContext() {
  const mockPage = createMockPage();
  return {
    pages: vi.fn(() => [mockPage]),
    newPage: vi.fn().mockResolvedValue(mockPage),
    cookies: vi.fn().mockResolvedValue([]),
    addCookies: vi.fn().mockResolvedValue(undefined),
    clearCookies: vi.fn().mockResolvedValue(undefined),
    setGeolocation: vi.fn().mockResolvedValue(undefined),
    setOffline: vi.fn().mockResolvedValue(undefined),
    setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    setHTTPCredentials: vi.fn().mockResolvedValue(undefined),
    newCDPSession: vi.fn().mockResolvedValue({
      send: vi.fn().mockResolvedValue(undefined),
    }),
    tracing: {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    },
  };
}

// Create mock stagehand
function createMockStagehand() {
  const mockPage = createMockPage();
  const mockContext = createMockContext();

  return {
    page: mockPage,
    context: mockContext,
    act: vi.fn().mockResolvedValue({ success: true }),
    extract: vi.fn().mockResolvedValue({ data: "extracted", found: true }),
    observe: vi.fn().mockResolvedValue([{ selector: "//button", description: "Submit button" }]),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

// Create mock session
function createMockSession(): BrowserSession {
  return {
    id: "test-session-123",
    clientId: "test-client",
    stagehand: createMockStagehand() as BrowserSession["stagehand"],
    observability: createMockObservabilityManager(),
    createdAt: new Date(),
    pendingDialogs: [],
    pendingDownloads: [],
  };
}

// Create mock session manager
function createMockSessionManager(session: BrowserSession | null = null): SessionManager {
  const mockSession = session || createMockSession();

  return {
    createSession: vi.fn().mockResolvedValue(mockSession),
    getSession: vi.fn(() => mockSession),
    destroySession: vi.fn().mockResolvedValue(undefined),
    getPage: vi.fn(() => mockSession?.stagehand.page),
    getContext: vi.fn(() => mockSession?.stagehand.context),
    listTabs: vi.fn().mockResolvedValue([
      { id: 0, url: "https://example.com", title: "Test", isActive: true },
    ]),
    createTab: vi.fn().mockResolvedValue({ tabId: 1, page: createMockPage() }),
    switchTab: vi.fn().mockResolvedValue(createMockPage()),
    closeTab: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionManager;
}

describe("MessageHandler", () => {
  let handler: MessageHandler;
  let mockLogger: Logger;
  let mockSessionManager: SessionManager;
  let mockSession: BrowserSession;

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockSession = createMockSession();
    mockSessionManager = createMockSessionManager(mockSession);
    handler = new MessageHandler(mockSessionManager, mockLogger);
  });

  describe("Message type coverage", () => {
    it("should handle all defined message types without throwing", async () => {
      const unhandledTypes: string[] = [];

      for (const type of ALL_MESSAGE_TYPES) {
        const message: Message = {
          type,
          requestId: `req-${type}`,
          sessionId: "test-session-123",
          data: {},
        };

        const response = await handler.handleMessage(message, "test-client");

        if (response.type === "error" && response.error?.includes("Unknown message type")) {
          unhandledTypes.push(type);
        }
      }

      if (unhandledTypes.length > 0) {
        throw new Error(`Unhandled message types: ${unhandledTypes.join(", ")}`);
      }
    });

    it("should return error for unknown message type", async () => {
      const response = await handler.handleMessage(
        { type: "unknownType", requestId: "req-1" },
        "client-1"
      );

      expect(response.success).toBe(false);
      expect(response.error).toContain("Unknown message type");
    });
  });

  describe("health", () => {
    it("should return health status", async () => {
      const response = await handler.handleMessage(
        { type: "health", requestId: "req-1" },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("health");
      expect(response.data?.status).toBe("ok");
    });
  });

  describe("session management", () => {
    it("should create session", async () => {
      const response = await handler.handleMessage(
        { type: "createSession", requestId: "req-1" },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("sessionCreated");
      expect(response.data?.sessionId).toBeDefined();
    });

    it("should destroy session", async () => {
      const response = await handler.handleMessage(
        { type: "destroySession", requestId: "req-1", sessionId: "test-session-123" },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("sessionDestroyed");
    });

    it("should return error for missing session", async () => {
      mockSessionManager.getSession = vi.fn(() => undefined);

      const response = await handler.handleMessage(
        { type: "navigate", requestId: "req-1", sessionId: "nonexistent", data: { url: "https://example.com" } },
        "client-1"
      );

      expect(response.success).toBe(false);
      expect(response.error).toBe("Session not found");
    });
  });

  describe("navigation", () => {
    it("should navigate to URL", async () => {
      const response = await handler.handleMessage(
        { type: "navigate", requestId: "req-1", sessionId: "test-session-123", data: { url: "https://example.com" } },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("navigated");
      expect(mockSession.stagehand.page.goto).toHaveBeenCalledWith("https://example.com");
    });

    it("should go back", async () => {
      const response = await handler.handleMessage(
        { type: "goBack", requestId: "req-1", sessionId: "test-session-123" },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("wentBack");
    });

    it("should go forward", async () => {
      const response = await handler.handleMessage(
        { type: "goForward", requestId: "req-1", sessionId: "test-session-123" },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("wentForward");
    });

    it("should refresh", async () => {
      const response = await handler.handleMessage(
        { type: "refresh", requestId: "req-1", sessionId: "test-session-123" },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("refreshed");
    });
  });

  describe("multi-tab", () => {
    it("should list tabs", async () => {
      const response = await handler.handleMessage(
        { type: "listTabs", requestId: "req-1", sessionId: "test-session-123" },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("tabsList");
      expect(response.data?.tabs).toBeDefined();
    });

    it("should create tab", async () => {
      const response = await handler.handleMessage(
        { type: "createTab", requestId: "req-1", sessionId: "test-session-123", data: { url: "https://example.com" } },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("tabCreated");
    });

    it("should switch tab", async () => {
      const response = await handler.handleMessage(
        { type: "switchTab", requestId: "req-1", sessionId: "test-session-123", data: { tabIndex: 0 } },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("tabSwitched");
    });

    it("should close tab", async () => {
      const response = await handler.handleMessage(
        { type: "closeTab", requestId: "req-1", sessionId: "test-session-123", data: { tabIndex: 0 } },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("tabClosed");
    });
  });

  describe("AI actions", () => {
    it("should perform AI click", async () => {
      const response = await handler.handleMessage(
        { type: "click", requestId: "req-1", sessionId: "test-session-123", data: { description: "submit button" } },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("clicked");
      // Stagehand v3 uses act(instruction) instead of act({ action })
      expect(mockSession.stagehand.act).toHaveBeenCalledWith("click on submit button");
    });

    it("should perform AI type", async () => {
      const response = await handler.handleMessage(
        { type: "type", requestId: "req-1", sessionId: "test-session-123", data: { text: "hello", field: "search input" } },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("typed");
    });

    it("should perform AI extract", async () => {
      const response = await handler.handleMessage(
        { type: "extract", requestId: "req-1", sessionId: "test-session-123", data: { instruction: "get the main heading" } },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("extracted");
    });

    it("should perform AI observe", async () => {
      const response = await handler.handleMessage(
        { type: "observe", requestId: "req-1", sessionId: "test-session-123", data: { instruction: "find all buttons" } },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("observed");
      expect(response.data?.observations).toBeDefined();
    });
  });

  describe("selector operations", () => {
    it("should query selector", async () => {
      const response = await handler.handleMessage(
        { type: "querySelector", requestId: "req-1", sessionId: "test-session-123", data: { selector: "#main" } },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("querySelector");
    });

    it("should click selector", async () => {
      const response = await handler.handleMessage(
        { type: "clickSelector", requestId: "req-1", sessionId: "test-session-123", data: { selector: "#btn" } },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("clickedSelector");
    });

    it("should fill selector", async () => {
      const response = await handler.handleMessage(
        { type: "fillSelector", requestId: "req-1", sessionId: "test-session-123", data: { selector: "#input", text: "test" } },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("filledSelector");
    });
  });

  describe("wait operations", () => {
    it("should wait for selector", async () => {
      const response = await handler.handleMessage(
        { type: "waitForSelector", requestId: "req-1", sessionId: "test-session-123", data: { selector: "#loaded" } },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("waitedForSelector");
    });

    it("should wait for URL", async () => {
      const response = await handler.handleMessage(
        { type: "waitForUrl", requestId: "req-1", sessionId: "test-session-123", data: { url: "**/success" } },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("waitedForUrl");
    });

    it("should wait for load state", async () => {
      const response = await handler.handleMessage(
        { type: "waitForLoadState", requestId: "req-1", sessionId: "test-session-123", data: { state: "networkidle" } },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("waitedForLoadState");
    });
  });

  describe("evaluate", () => {
    it("should evaluate JavaScript", async () => {
      const response = await handler.handleMessage(
        { type: "evaluate", requestId: "req-1", sessionId: "test-session-123", data: { script: "return document.title" } },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("evaluated");
    });
  });

  describe("screenshot & PDF", () => {
    it("should take screenshot", async () => {
      const response = await handler.handleMessage(
        { type: "screenshot", requestId: "req-1", sessionId: "test-session-123" },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("screenshot");
      expect(response.data?.screenshot).toBeDefined();
      expect(response.data?.mimeType).toBe("image/png");
    });

    it("should export PDF", async () => {
      const response = await handler.handleMessage(
        { type: "exportPdf", requestId: "req-1", sessionId: "test-session-123" },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("pdfExported");
    });
  });

  describe("observability", () => {
    it("should get console messages", async () => {
      const response = await handler.handleMessage(
        { type: "getConsole", requestId: "req-1", sessionId: "test-session-123" },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("console");
    });

    it("should get errors", async () => {
      const response = await handler.handleMessage(
        { type: "getErrors", requestId: "req-1", sessionId: "test-session-123" },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("errors");
    });

    it("should get network requests", async () => {
      const response = await handler.handleMessage(
        { type: "getNetwork", requestId: "req-1", sessionId: "test-session-123" },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("network");
    });

    it("should get observability stats", async () => {
      const response = await handler.handleMessage(
        { type: "getObservabilityStats", requestId: "req-1", sessionId: "test-session-123" },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("observabilityStats");
    });
  });

  describe("storage", () => {
    it("should get cookies", async () => {
      const response = await handler.handleMessage(
        { type: "getCookies", requestId: "req-1", sessionId: "test-session-123" },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("cookies");
    });

    it("should set cookies", async () => {
      const response = await handler.handleMessage(
        {
          type: "setCookies",
          requestId: "req-1",
          sessionId: "test-session-123",
          data: {
            cookies: [{ name: "test", value: "value", url: "https://example.com" }],
          },
        },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("cookiesSet");
    });

    it("should clear cookies", async () => {
      const response = await handler.handleMessage(
        { type: "clearCookies", requestId: "req-1", sessionId: "test-session-123" },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("cookiesCleared");
    });

    it("should get localStorage", async () => {
      const response = await handler.handleMessage(
        { type: "getLocalStorage", requestId: "req-1", sessionId: "test-session-123" },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("localStorage");
    });

    it("should set localStorage", async () => {
      const response = await handler.handleMessage(
        { type: "setLocalStorage", requestId: "req-1", sessionId: "test-session-123", data: { key: "test", value: "value" } },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("localStorageSet");
    });
  });

  describe("environment", () => {
    it("should set viewport", async () => {
      const response = await handler.handleMessage(
        { type: "setViewport", requestId: "req-1", sessionId: "test-session-123", data: { width: 1920, height: 1080 } },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("viewportSet");
    });

    it("should set geolocation", async () => {
      const response = await handler.handleMessage(
        { type: "setGeolocation", requestId: "req-1", sessionId: "test-session-123", data: { latitude: 37.7749, longitude: -122.4194 } },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("geolocationSet");
    });

    it("should set offline mode", async () => {
      const response = await handler.handleMessage(
        { type: "setOffline", requestId: "req-1", sessionId: "test-session-123", data: { offline: true } },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("offlineSet");
    });

    it("should emulate media", async () => {
      const response = await handler.handleMessage(
        { type: "emulateMedia", requestId: "req-1", sessionId: "test-session-123", data: { colorScheme: "dark" } },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("mediaEmulated");
    });
  });

  describe("dialogs", () => {
    it("should get dialogs", async () => {
      const response = await handler.handleMessage(
        { type: "getDialogs", requestId: "req-1", sessionId: "test-session-123" },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("dialogs");
    });

    it("should return error when no dialog to handle", async () => {
      const response = await handler.handleMessage(
        { type: "handleDialog", requestId: "req-1", sessionId: "test-session-123", data: { accept: true } },
        "client-1"
      );

      expect(response.success).toBe(false);
      expect(response.error).toContain("No pending dialog");
    });
  });

  describe("downloads", () => {
    it("should get downloads", async () => {
      const response = await handler.handleMessage(
        { type: "getDownloads", requestId: "req-1", sessionId: "test-session-123" },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("downloads");
    });
  });

  describe("state", () => {
    it("should get state", async () => {
      const response = await handler.handleMessage(
        { type: "getState", requestId: "req-1", sessionId: "test-session-123" },
        "client-1"
      );

      expect(response.success).toBe(true);
      expect(response.type).toBe("state");
      expect(response.data?.url).toBeDefined();
      expect(response.data?.title).toBeDefined();
    });
  });

  describe("error handling", () => {
    it("should catch and return errors gracefully", async () => {
      // Make navigate throw an error
      mockSession.stagehand.page.goto = vi.fn().mockRejectedValue(new Error("Network error"));

      const response = await handler.handleMessage(
        { type: "navigate", requestId: "req-1", sessionId: "test-session-123", data: { url: "https://example.com" } },
        "client-1"
      );

      expect(response.success).toBe(false);
      expect(response.type).toBe("error");
      expect(response.error).toBe("Network error");
    });
  });
});
