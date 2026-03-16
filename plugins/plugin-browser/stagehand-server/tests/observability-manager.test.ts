import { describe, it, expect, beforeEach, vi } from "vitest";
import { ObservabilityManager } from "../src/observability-manager.js";
import type { Page, ConsoleMessage as PlaywrightConsoleMessage, Request, Response } from "playwright";

// Mock Playwright Page
function createMockPage(): Page {
  const listeners: Map<string, Function[]> = new Map();

  const mockPage = {
    on: vi.fn((event: string, handler: Function) => {
      if (!listeners.has(event)) {
        listeners.set(event, []);
      }
      listeners.get(event)!.push(handler);
    }),
    emit: (event: string, ...args: unknown[]) => {
      const handlers = listeners.get(event) || [];
      for (const handler of handlers) {
        handler(...args);
      }
    },
    url: vi.fn(() => "https://example.com"),
  } as unknown as Page & { emit: (event: string, ...args: unknown[]) => void };

  return mockPage;
}

// Mock console message
function createMockConsoleMessage(type: string, text: string): PlaywrightConsoleMessage {
  return {
    type: () => type,
    text: () => text,
    location: () => ({ url: "https://example.com/script.js", lineNumber: 10, columnNumber: 5 }),
  } as PlaywrightConsoleMessage;
}

// Mock network request
function createMockRequest(method: string, url: string, resourceType: string = "document"): Request {
  return {
    method: () => method,
    url: () => url,
    resourceType: () => resourceType,
    failure: () => null,
  } as Request;
}

// Mock network response
function createMockResponse(request: Request, status: number, ok: boolean): Response {
  return {
    request: () => request,
    status: () => status,
    ok: () => ok,
    headers: () => ({ "content-type": "text/html" }),
  } as Response;
}

describe("ObservabilityManager", () => {
  let manager: ObservabilityManager;
  let mockPage: Page & { emit: (event: string, ...args: unknown[]) => void };

  beforeEach(() => {
    manager = new ObservabilityManager();
    mockPage = createMockPage() as Page & { emit: (event: string, ...args: unknown[]) => void };
  });

  describe("attachToPage", () => {
    it("should attach to page only once", () => {
      manager.attachToPage(mockPage);
      manager.attachToPage(mockPage);

      // Should only attach listeners once (console, pageerror, request, response, requestfailed, close)
      expect(mockPage.on).toHaveBeenCalledTimes(6);
    });
  });

  describe("console messages", () => {
    it("should capture console messages", () => {
      manager.attachToPage(mockPage);

      mockPage.emit("console", createMockConsoleMessage("log", "Hello world"));
      mockPage.emit("console", createMockConsoleMessage("error", "Something went wrong"));

      const messages = manager.getConsoleMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0].text).toBe("Hello world");
      expect(messages[0].type).toBe("log");
      expect(messages[1].text).toBe("Something went wrong");
      expect(messages[1].type).toBe("error");
    });

    it("should filter console messages by level", () => {
      manager.attachToPage(mockPage);

      mockPage.emit("console", createMockConsoleMessage("debug", "Debug message"));
      mockPage.emit("console", createMockConsoleMessage("log", "Log message"));
      mockPage.emit("console", createMockConsoleMessage("warning", "Warning message"));
      mockPage.emit("console", createMockConsoleMessage("error", "Error message"));

      const errorOnly = manager.getConsoleMessages("error");
      expect(errorOnly).toHaveLength(1);
      expect(errorOnly[0].type).toBe("error");

      const warningAndAbove = manager.getConsoleMessages("warning");
      expect(warningAndAbove).toHaveLength(2);

      const allMessages = manager.getConsoleMessages();
      expect(allMessages).toHaveLength(4);
    });

    it("should include location information", () => {
      manager.attachToPage(mockPage);

      mockPage.emit("console", createMockConsoleMessage("log", "Test"));

      const messages = manager.getConsoleMessages();
      expect(messages[0].location).toEqual({
        url: "https://example.com/script.js",
        lineNumber: 10,
        columnNumber: 5,
      });
    });
  });

  describe("page errors", () => {
    it("should capture page errors", () => {
      manager.attachToPage(mockPage);

      const error = new Error("Test error");
      error.stack = "Error: Test error\n    at test.js:10:5";
      mockPage.emit("pageerror", error);

      const errors = manager.getPageErrors();
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe("Test error");
      expect(errors[0].name).toBe("Error");
      expect(errors[0].stack).toContain("test.js:10:5");
    });

    it("should clear errors when requested", () => {
      manager.attachToPage(mockPage);

      mockPage.emit("pageerror", new Error("Error 1"));
      mockPage.emit("pageerror", new Error("Error 2"));

      const errors1 = manager.getPageErrors(true);
      expect(errors1).toHaveLength(2);

      const errors2 = manager.getPageErrors();
      expect(errors2).toHaveLength(0);
    });
  });

  describe("network requests", () => {
    it("should capture network requests", () => {
      manager.attachToPage(mockPage);

      const request = createMockRequest("GET", "https://api.example.com/data");
      mockPage.emit("request", request);

      const requests = manager.getNetworkRequests();
      expect(requests).toHaveLength(1);
      expect(requests[0].method).toBe("GET");
      expect(requests[0].url).toBe("https://api.example.com/data");
    });

    it("should update request with response data", () => {
      manager.attachToPage(mockPage);

      const request = createMockRequest("GET", "https://api.example.com/data");
      mockPage.emit("request", request);

      const response = createMockResponse(request, 200, true);
      mockPage.emit("response", response);

      const requests = manager.getNetworkRequests();
      expect(requests[0].status).toBe(200);
      expect(requests[0].ok).toBe(true);
      expect(requests[0].responseHeaders).toEqual({ "content-type": "text/html" });
    });

    it("should filter network requests by URL", () => {
      manager.attachToPage(mockPage);

      mockPage.emit("request", createMockRequest("GET", "https://api.example.com/users"));
      mockPage.emit("request", createMockRequest("GET", "https://api.example.com/posts"));
      mockPage.emit("request", createMockRequest("GET", "https://other.com/data"));

      const filtered = manager.getNetworkRequests("example.com");
      expect(filtered).toHaveLength(2);

      const postsOnly = manager.getNetworkRequests("posts");
      expect(postsOnly).toHaveLength(1);
    });

    it("should handle request failures", () => {
      manager.attachToPage(mockPage);

      const request = {
        method: () => "GET",
        url: () => "https://api.example.com/fail",
        resourceType: () => "xhr",
        failure: () => ({ errorText: "net::ERR_CONNECTION_REFUSED" }),
      } as Request;

      mockPage.emit("request", request);
      mockPage.emit("requestfailed", request);

      const requests = manager.getNetworkRequests();
      expect(requests[0].failureText).toBe("net::ERR_CONNECTION_REFUSED");
      expect(requests[0].ok).toBe(false);
    });
  });

  describe("stats", () => {
    it("should return correct stats", () => {
      manager.attachToPage(mockPage);

      mockPage.emit("console", createMockConsoleMessage("log", "Log 1"));
      mockPage.emit("console", createMockConsoleMessage("log", "Log 2"));
      mockPage.emit("pageerror", new Error("Error 1"));
      mockPage.emit("request", createMockRequest("GET", "https://example.com"));

      const stats = manager.getStats();
      expect(stats.consoleCount).toBe(2);
      expect(stats.errorCount).toBe(1);
      expect(stats.networkCount).toBe(1);
    });
  });

  describe("clearAll", () => {
    it("should clear all data", () => {
      manager.attachToPage(mockPage);

      mockPage.emit("console", createMockConsoleMessage("log", "Log"));
      mockPage.emit("pageerror", new Error("Error"));
      mockPage.emit("request", createMockRequest("GET", "https://example.com"));

      manager.clearAll();

      expect(manager.getConsoleMessages()).toHaveLength(0);
      expect(manager.getPageErrors()).toHaveLength(0);
      expect(manager.getNetworkRequests()).toHaveLength(0);
    });
  });

  describe("buffer limits", () => {
    it("should limit console messages", () => {
      manager.attachToPage(mockPage);

      // Add more than MAX_CONSOLE_MESSAGES (500)
      for (let i = 0; i < 510; i++) {
        mockPage.emit("console", createMockConsoleMessage("log", `Message ${i}`));
      }

      const messages = manager.getConsoleMessages();
      expect(messages.length).toBeLessThanOrEqual(500);
      // Should have removed oldest messages
      expect(messages[0].text).toBe("Message 10");
    });
  });
});
