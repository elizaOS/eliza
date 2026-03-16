/**
 * Google MCP Tools Integration Tests
 *
 * Tests the Google MCP tools module with comprehensive coverage:
 * - Tool registration and export
 * - Error handling when Google not connected
 * - Input validation and edge cases
 * - API response handling
 * - Concurrent request isolation
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { authContextStorage } from "@/app/api/mcp/lib/context";

// Mock fetch globally for API tests
const originalFetch = globalThis.fetch;
let mockFetchResponses: Map<string, { status: number; body: any }> = new Map();

function setupMockFetch() {
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = url.toString();

    // Find matching mock response
    for (const [pattern, response] of mockFetchResponses) {
      if (urlStr.includes(pattern)) {
        return new Response(JSON.stringify(response.body), {
          status: response.status,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Default: return 404
    return new Response(JSON.stringify({ error: { message: "Not found" } }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function resetMockFetch() {
  globalThis.fetch = originalFetch;
  mockFetchResponses.clear();
}

// Mock OAuth service
const mockOAuthService = {
  getValidTokenByPlatform: mock(async ({ organizationId, platform }: { organizationId: string; platform: string }) => {
    if (platform !== "google") {
      throw new Error(`Unknown platform: ${platform}`);
    }
    // By default, throw "not connected" - tests can override
    throw new Error("No active connection found for google");
  }),
  listConnections: mock(async ({ organizationId, platform }: { organizationId: string; platform?: string }) => {
    return [];
  }),
  isPlatformConnected: mock(async (organizationId: string, platform: string) => {
    return false;
  }),
};

// Mock the oauth service module
mock.module("@/lib/services/oauth", () => ({
  oauthService: mockOAuthService,
}));

// Create mock auth context
function createMockAuth(orgId: string = "test-org-123") {
  return {
    user: {
      id: `user-${orgId}`,
      organization_id: orgId,
      organization: { id: orgId, name: "Test Organization", credit_balance: 100 },
    },
  } as any;
}

describe("Google MCP Tools", () => {
  beforeEach(() => {
    setupMockFetch();
    // Reset mock implementations
    mockOAuthService.getValidTokenByPlatform.mockReset();
    mockOAuthService.listConnections.mockReset();
  });

  afterEach(() => {
    resetMockFetch();
  });

  // ============================================
  // Module Import & Registration Tests
  // ============================================

  describe("Module Registration", () => {
    test("registerGoogleTools is exported", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");
      expect(registerGoogleTools).toBeDefined();
      expect(typeof registerGoogleTools).toBe("function");
    });

    test("registers all expected tools", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");

      const registeredTools: string[] = [];
      const mockServer = {
        registerTool: (name: string, _schema: any, _handler: any) => {
          registeredTools.push(name);
        },
      };

      registerGoogleTools(mockServer as any);

      expect(registeredTools).toContain("google_status");
      expect(registeredTools).toContain("gmail_send");
      expect(registeredTools).toContain("gmail_list");
      expect(registeredTools).toContain("gmail_read");
      expect(registeredTools).toContain("calendar_list_events");
      expect(registeredTools).toContain("calendar_create_event");
      expect(registeredTools).toContain("calendar_update_event");
      expect(registeredTools).toContain("calendar_delete_event");
      expect(registeredTools).toContain("contacts_list");
      expect(registeredTools.length).toBe(9);
    });
  });

  // ============================================
  // google_status Tool Tests
  // ============================================

  describe("google_status", () => {
    test("returns connected=false when no Google connection", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");

      mockOAuthService.listConnections.mockImplementation(async () => []);

      let handler: any;
      const mockServer = {
        registerTool: (name: string, _schema: any, h: any) => {
          if (name === "google_status") handler = h;
        },
      };
      registerGoogleTools(mockServer as any);

      const result = await authContextStorage.run(createMockAuth(), async () => {
        return handler({});
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.connected).toBe(false);
      expect(parsed.message).toContain("not connected");
    });

    test("returns connection details when connected", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");

      mockOAuthService.listConnections.mockImplementation(async () => [
        {
          id: "conn-123",
          status: "active",
          email: "user@example.com",
          scopes: ["gmail.send", "calendar.events"],
          linkedAt: "2024-01-15T10:00:00Z",
        },
      ]);

      let handler: any;
      const mockServer = {
        registerTool: (name: string, _schema: any, h: any) => {
          if (name === "google_status") handler = h;
        },
      };
      registerGoogleTools(mockServer as any);

      const result = await authContextStorage.run(createMockAuth(), async () => {
        return handler({});
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.connected).toBe(true);
      expect(parsed.email).toBe("user@example.com");
      expect(parsed.scopes).toContain("gmail.send");
      expect(parsed.linkedAt).toBe("2024-01-15T10:00:00Z");
    });

    test("handles service errors gracefully", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");

      mockOAuthService.listConnections.mockImplementation(async () => {
        throw new Error("Database connection failed");
      });

      let handler: any;
      const mockServer = {
        registerTool: (name: string, _schema: any, h: any) => {
          if (name === "google_status") handler = h;
        },
      };
      registerGoogleTools(mockServer as any);

      const result = await authContextStorage.run(createMockAuth(), async () => {
        return handler({});
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe("Database connection failed");
    });

    test("filters for active connections only", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");

      mockOAuthService.listConnections.mockImplementation(async () => [
        { id: "conn-1", status: "revoked", email: "old@example.com" },
        { id: "conn-2", status: "expired", email: "expired@example.com" },
      ]);

      let handler: any;
      const mockServer = {
        registerTool: (name: string, _schema: any, h: any) => {
          if (name === "google_status") handler = h;
        },
      };
      registerGoogleTools(mockServer as any);

      const result = await authContextStorage.run(createMockAuth(), async () => {
        return handler({});
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.connected).toBe(false);
    });
  });

  // ============================================
  // gmail_send Tool Tests
  // ============================================

  describe("gmail_send", () => {
    test("returns error when Google not connected", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");

      mockOAuthService.getValidTokenByPlatform.mockImplementation(async () => {
        throw new Error("No active connection found for google");
      });

      let handler: any;
      const mockServer = {
        registerTool: (name: string, _schema: any, h: any) => {
          if (name === "gmail_send") handler = h;
        },
      };
      registerGoogleTools(mockServer as any);

      const result = await authContextStorage.run(createMockAuth(), async () => {
        return handler({
          to: "recipient@example.com",
          subject: "Test",
          body: "Hello",
        });
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("Google account not connected");
    });

    test("sends email successfully", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");

      mockOAuthService.getValidTokenByPlatform.mockImplementation(async () => ({
        accessToken: "mock-token-123",
      }));

      mockFetchResponses.set("gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        status: 200,
        body: { id: "msg-123", threadId: "thread-456" },
      });

      let handler: any;
      const mockServer = {
        registerTool: (name: string, _schema: any, h: any) => {
          if (name === "gmail_send") handler = h;
        },
      };
      registerGoogleTools(mockServer as any);

      const result = await authContextStorage.run(createMockAuth(), async () => {
        return handler({
          to: "recipient@example.com",
          subject: "Test Subject",
          body: "Test body content",
        });
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.messageId).toBe("msg-123");
      expect(parsed.threadId).toBe("thread-456");
    });

    test("handles CC and BCC recipients", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");

      mockOAuthService.getValidTokenByPlatform.mockImplementation(async () => ({
        accessToken: "mock-token-123",
      }));

      let capturedRequest: any;
      globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
        if (url.includes("gmail.googleapis.com")) {
          capturedRequest = { url, init };
          return new Response(JSON.stringify({ id: "msg-123", threadId: "thread-456" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("", { status: 404 });
      }) as typeof fetch;

      let handler: any;
      const mockServer = {
        registerTool: (name: string, _schema: any, h: any) => {
          if (name === "gmail_send") handler = h;
        },
      };
      registerGoogleTools(mockServer as any);

      await authContextStorage.run(createMockAuth(), async () => {
        return handler({
          to: "recipient@example.com",
          subject: "Test",
          body: "Hello",
          cc: "cc@example.com",
          bcc: "bcc@example.com",
        });
      });

      // Verify the request was made with proper auth
      expect(capturedRequest).toBeDefined();
      expect(capturedRequest.init.headers.Authorization).toBe("Bearer mock-token-123");
    });

    test("handles Gmail API errors", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");

      mockOAuthService.getValidTokenByPlatform.mockImplementation(async () => ({
        accessToken: "mock-token-123",
      }));

      mockFetchResponses.set("gmail.googleapis.com", {
        status: 403,
        body: { error: { message: "Insufficient permissions" } },
      });

      let handler: any;
      const mockServer = {
        registerTool: (name: string, _schema: any, h: any) => {
          if (name === "gmail_send") handler = h;
        },
      };
      registerGoogleTools(mockServer as any);

      const result = await authContextStorage.run(createMockAuth(), async () => {
        return handler({
          to: "recipient@example.com",
          subject: "Test",
          body: "Hello",
        });
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("Insufficient permissions");
    });

    test("handles HTML email content", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");

      mockOAuthService.getValidTokenByPlatform.mockImplementation(async () => ({
        accessToken: "mock-token-123",
      }));

      let capturedBody: any;
      globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
        if (url.includes("gmail.googleapis.com")) {
          capturedBody = JSON.parse(init?.body as string);
          return new Response(JSON.stringify({ id: "msg-123", threadId: "thread-456" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("", { status: 404 });
      }) as typeof fetch;

      let handler: any;
      const mockServer = {
        registerTool: (name: string, _schema: any, h: any) => {
          if (name === "gmail_send") handler = h;
        },
      };
      registerGoogleTools(mockServer as any);

      await authContextStorage.run(createMockAuth(), async () => {
        return handler({
          to: "recipient@example.com",
          subject: "HTML Test",
          body: "<h1>Hello</h1><p>This is HTML</p>",
          isHtml: true,
        });
      });

      // Decode and verify content type header
      const decoded = Buffer.from(capturedBody.raw, "base64").toString("utf-8");
      expect(decoded).toContain("text/html");
    });
  });

  // ============================================
  // gmail_list Tool Tests
  // ============================================

  describe("gmail_list", () => {
    test("returns empty list when no messages", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");

      mockOAuthService.getValidTokenByPlatform.mockImplementation(async () => ({
        accessToken: "mock-token-123",
      }));

      mockFetchResponses.set("gmail.googleapis.com/gmail/v1/users/me/messages", {
        status: 200,
        body: { messages: [] },
      });

      let handler: any;
      const mockServer = {
        registerTool: (name: string, _schema: any, h: any) => {
          if (name === "gmail_list") handler = h;
        },
      };
      registerGoogleTools(mockServer as any);

      const result = await authContextStorage.run(createMockAuth(), async () => {
        return handler({});
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.messages).toEqual([]);
      expect(parsed.count).toBe(0);
    });

    test("respects maxResults parameter", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");

      mockOAuthService.getValidTokenByPlatform.mockImplementation(async () => ({
        accessToken: "mock-token-123",
      }));

      let capturedUrl: string = "";
      globalThis.fetch = mock(async (url: string) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ messages: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      let handler: any;
      const mockServer = {
        registerTool: (name: string, _schema: any, h: any) => {
          if (name === "gmail_list") handler = h;
        },
      };
      registerGoogleTools(mockServer as any);

      await authContextStorage.run(createMockAuth(), async () => {
        return handler({ maxResults: 25 });
      });

      expect(capturedUrl).toContain("maxResults=25");
    });

    test("passes query parameter to Gmail API", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");

      mockOAuthService.getValidTokenByPlatform.mockImplementation(async () => ({
        accessToken: "mock-token-123",
      }));

      let capturedUrl: string = "";
      globalThis.fetch = mock(async (url: string) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ messages: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      let handler: any;
      const mockServer = {
        registerTool: (name: string, _schema: any, h: any) => {
          if (name === "gmail_list") handler = h;
        },
      };
      registerGoogleTools(mockServer as any);

      await authContextStorage.run(createMockAuth(), async () => {
        return handler({ query: "is:unread from:boss@company.com" });
      });

      expect(capturedUrl).toContain("q=");
      expect(capturedUrl).toContain("unread");
    });

    test("reports partial failures when some messages fail to fetch", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");

      mockOAuthService.getValidTokenByPlatform.mockImplementation(async () => ({
        accessToken: "mock-token-123",
      }));

      let requestCount = 0;
      globalThis.fetch = mock(async (url: string) => {
        // First call: list messages
        if (url.includes("/messages?")) {
          return new Response(
            JSON.stringify({ messages: [{ id: "msg-1" }, { id: "msg-2" }, { id: "msg-3" }] }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        // Individual message fetches: fail one
        requestCount++;
        if (url.includes("msg-2")) {
          return new Response(
            JSON.stringify({ error: { message: "Message not found" } }),
            { status: 404, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(
          JSON.stringify({
            id: url.includes("msg-1") ? "msg-1" : "msg-3",
            threadId: "thread-1",
            snippet: "Test",
            payload: { headers: [] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }) as typeof fetch;

      let handler: any;
      const mockServer = {
        registerTool: (name: string, _schema: any, h: any) => {
          if (name === "gmail_list") handler = h;
        },
      };
      registerGoogleTools(mockServer as any);

      const result = await authContextStorage.run(createMockAuth(), async () => {
        return handler({});
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(2); // Only 2 succeeded
      expect(parsed.failedToFetch).toBe(1); // 1 failed
    });
  });

  // ============================================
  // gmail_read Tool Tests
  // ============================================

  describe("gmail_read", () => {
    test("reads message with full content", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");

      mockOAuthService.getValidTokenByPlatform.mockImplementation(async () => ({
        accessToken: "mock-token-123",
      }));

      const mockMessage = {
        id: "msg-123",
        threadId: "thread-456",
        labelIds: ["INBOX", "UNREAD"],
        snippet: "This is a preview...",
        internalDate: "1704067200000",
        payload: {
          headers: [
            { name: "From", value: "sender@example.com" },
            { name: "Subject", value: "Test Subject" },
          ],
          body: {
            data: Buffer.from("Hello, this is the email body!").toString("base64"),
          },
        },
      };

      mockFetchResponses.set("gmail.googleapis.com/gmail/v1/users/me/messages/msg-123", {
        status: 200,
        body: mockMessage,
      });

      let handler: any;
      const mockServer = {
        registerTool: (name: string, _schema: any, h: any) => {
          if (name === "gmail_read") handler = h;
        },
      };
      registerGoogleTools(mockServer as any);

      const result = await authContextStorage.run(createMockAuth(), async () => {
        return handler({ messageId: "msg-123" });
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.id).toBe("msg-123");
      expect(parsed.headers.From).toBe("sender@example.com");
      expect(parsed.body).toBe("Hello, this is the email body!");
    });

    test("handles multipart messages", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");

      mockOAuthService.getValidTokenByPlatform.mockImplementation(async () => ({
        accessToken: "mock-token-123",
      }));

      const mockMessage = {
        id: "msg-456",
        threadId: "thread-789",
        payload: {
          headers: [],
          parts: [
            {
              mimeType: "text/plain",
              body: { data: Buffer.from("Plain text content").toString("base64") },
            },
            {
              mimeType: "text/html",
              body: { data: Buffer.from("<p>HTML content</p>").toString("base64") },
            },
          ],
        },
      };

      mockFetchResponses.set("gmail.googleapis.com/gmail/v1/users/me/messages/msg-456", {
        status: 200,
        body: mockMessage,
      });

      let handler: any;
      const mockServer = {
        registerTool: (name: string, _schema: any, h: any) => {
          if (name === "gmail_read") handler = h;
        },
      };
      registerGoogleTools(mockServer as any);

      const result = await authContextStorage.run(createMockAuth(), async () => {
        return handler({ messageId: "msg-456" });
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.body).toBe("Plain text content");
    });

    test("handles deeply nested multipart messages", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");

      mockOAuthService.getValidTokenByPlatform.mockImplementation(async () => ({
        accessToken: "mock-token-123",
      }));

      // Nested structure: multipart/mixed > multipart/alternative > text/plain
      const mockMessage = {
        id: "msg-nested",
        threadId: "thread-nested",
        payload: {
          mimeType: "multipart/mixed",
          headers: [],
          parts: [
            {
              mimeType: "multipart/alternative",
              parts: [
                {
                  mimeType: "text/plain",
                  body: { data: Buffer.from("Nested plain text").toString("base64") },
                },
                {
                  mimeType: "text/html",
                  body: { data: Buffer.from("<p>Nested HTML</p>").toString("base64") },
                },
              ],
            },
            {
              mimeType: "application/pdf",
              filename: "attachment.pdf",
              body: { attachmentId: "att-123" },
            },
          ],
        },
      };

      mockFetchResponses.set("gmail.googleapis.com/gmail/v1/users/me/messages/msg-nested", {
        status: 200,
        body: mockMessage,
      });

      let handler: any;
      const mockServer = {
        registerTool: (name: string, _schema: any, h: any) => {
          if (name === "gmail_read") handler = h;
        },
      };
      registerGoogleTools(mockServer as any);

      const result = await authContextStorage.run(createMockAuth(), async () => {
        return handler({ messageId: "msg-nested" });
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.body).toBe("Nested plain text");
    });

    test("returns error for non-existent message", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");

      mockOAuthService.getValidTokenByPlatform.mockImplementation(async () => ({
        accessToken: "mock-token-123",
      }));

      mockFetchResponses.set("gmail.googleapis.com", {
        status: 404,
        body: { error: { message: "Message not found" } },
      });

      let handler: any;
      const mockServer = {
        registerTool: (name: string, _schema: any, h: any) => {
          if (name === "gmail_read") handler = h;
        },
      };
      registerGoogleTools(mockServer as any);

      const result = await authContextStorage.run(createMockAuth(), async () => {
        return handler({ messageId: "nonexistent-id" });
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("not found");
    });
  });

  // ============================================
  // Calendar Tools Tests
  // ============================================

  describe("calendar_list_events", () => {
    test("lists events with default parameters", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");

      mockOAuthService.getValidTokenByPlatform.mockImplementation(async () => ({
        accessToken: "mock-token-123",
      }));

      mockFetchResponses.set("googleapis.com/calendar/v3/calendars", {
        status: 200,
        body: {
          items: [
            {
              id: "event-1",
              summary: "Team Meeting",
              start: { dateTime: "2024-01-15T10:00:00Z" },
              end: { dateTime: "2024-01-15T11:00:00Z" },
              status: "confirmed",
            },
          ],
        },
      });

      let handler: any;
      const mockServer = {
        registerTool: (name: string, _schema: any, h: any) => {
          if (name === "calendar_list_events") handler = h;
        },
      };
      registerGoogleTools(mockServer as any);

      const result = await authContextStorage.run(createMockAuth(), async () => {
        return handler({});
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(1);
      expect(parsed.events[0].summary).toBe("Team Meeting");
    });

    test("handles all-day events (date without time)", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");

      mockOAuthService.getValidTokenByPlatform.mockImplementation(async () => ({
        accessToken: "mock-token-123",
      }));

      mockFetchResponses.set("googleapis.com/calendar/v3/calendars", {
        status: 200,
        body: {
          items: [
            {
              id: "event-1",
              summary: "Holiday",
              start: { date: "2024-01-15" },
              end: { date: "2024-01-16" },
            },
          ],
        },
      });

      let handler: any;
      const mockServer = {
        registerTool: (name: string, _schema: any, h: any) => {
          if (name === "calendar_list_events") handler = h;
        },
      };
      registerGoogleTools(mockServer as any);

      const result = await authContextStorage.run(createMockAuth(), async () => {
        return handler({});
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.events[0].start).toBe("2024-01-15");
    });
  });

  describe("calendar_create_event", () => {
    test("creates event successfully", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");

      mockOAuthService.getValidTokenByPlatform.mockImplementation(async () => ({
        accessToken: "mock-token-123",
      }));

      mockFetchResponses.set("googleapis.com/calendar/v3/calendars", {
        status: 200,
        body: {
          id: "new-event-123",
          htmlLink: "https://calendar.google.com/event/123",
          status: "confirmed",
        },
      });

      let handler: any;
      const mockServer = {
        registerTool: (name: string, _schema: any, h: any) => {
          if (name === "calendar_create_event") handler = h;
        },
      };
      registerGoogleTools(mockServer as any);

      const result = await authContextStorage.run(createMockAuth(), async () => {
        return handler({
          summary: "Project Kickoff",
          start: "2024-01-20T14:00:00Z",
          end: "2024-01-20T15:00:00Z",
          description: "Initial project planning meeting",
          location: "Conference Room A",
        });
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.eventId).toBe("new-event-123");
      expect(parsed.htmlLink).toContain("calendar.google.com");
    });

    test("creates event with attendees", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");

      mockOAuthService.getValidTokenByPlatform.mockImplementation(async () => ({
        accessToken: "mock-token-123",
      }));

      let capturedBody: any;
      globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
        if (url.includes("calendar/v3")) {
          capturedBody = JSON.parse(init?.body as string);
          return new Response(
            JSON.stringify({ id: "event-123", htmlLink: "https://cal.google.com", status: "confirmed" }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("", { status: 404 });
      }) as typeof fetch;

      let handler: any;
      const mockServer = {
        registerTool: (name: string, _schema: any, h: any) => {
          if (name === "calendar_create_event") handler = h;
        },
      };
      registerGoogleTools(mockServer as any);

      await authContextStorage.run(createMockAuth(), async () => {
        return handler({
          summary: "Team Sync",
          start: "2024-01-20T14:00:00Z",
          end: "2024-01-20T15:00:00Z",
          attendees: ["alice@example.com", "bob@example.com"],
        });
      });

      expect(capturedBody.attendees).toBeDefined();
      expect(capturedBody.attendees).toHaveLength(2);
      expect(capturedBody.attendees[0].email).toBe("alice@example.com");
    });
  });

  describe("calendar_delete_event", () => {
    test("deletes event successfully (204 response)", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");

      mockOAuthService.getValidTokenByPlatform.mockImplementation(async () => ({
        accessToken: "mock-token-123",
      }));

      globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
        if (url.includes("calendar/v3") && init?.method === "DELETE") {
          return new Response("", { status: 204 });
        }
        return new Response("", { status: 404 });
      }) as typeof fetch;

      let handler: any;
      const mockServer = {
        registerTool: (name: string, _schema: any, h: any) => {
          if (name === "calendar_delete_event") handler = h;
        },
      };
      registerGoogleTools(mockServer as any);

      const result = await authContextStorage.run(createMockAuth(), async () => {
        return handler({ eventId: "event-to-delete" });
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
    });
  });

  // ============================================
  // contacts_list Tool Tests
  // ============================================

  describe("contacts_list", () => {
    test("lists contacts from connections API", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");

      mockOAuthService.getValidTokenByPlatform.mockImplementation(async () => ({
        accessToken: "mock-token-123",
      }));

      mockFetchResponses.set("people.googleapis.com/v1/people/me/connections", {
        status: 200,
        body: {
          connections: [
            {
              resourceName: "people/123",
              names: [{ displayName: "John Doe" }],
              emailAddresses: [{ value: "john@example.com" }],
              phoneNumbers: [{ value: "+1-555-1234" }],
              organizations: [{ name: "Acme Corp" }],
            },
          ],
        },
      });

      let handler: any;
      const mockServer = {
        registerTool: (name: string, _schema: any, h: any) => {
          if (name === "contacts_list") handler = h;
        },
      };
      registerGoogleTools(mockServer as any);

      const result = await authContextStorage.run(createMockAuth(), async () => {
        return handler({});
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(1);
      expect(parsed.contacts[0].name).toBe("John Doe");
      expect(parsed.contacts[0].email).toBe("john@example.com");
    });

    test("uses search API when query provided", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");

      mockOAuthService.getValidTokenByPlatform.mockImplementation(async () => ({
        accessToken: "mock-token-123",
      }));

      let capturedUrl: string = "";
      globalThis.fetch = mock(async (url: string) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      let handler: any;
      const mockServer = {
        registerTool: (name: string, _schema: any, h: any) => {
          if (name === "contacts_list") handler = h;
        },
      };
      registerGoogleTools(mockServer as any);

      await authContextStorage.run(createMockAuth(), async () => {
        return handler({ query: "John" });
      });

      expect(capturedUrl).toContain("searchContacts");
      expect(capturedUrl).toContain("query=John");
    });
  });

  // ============================================
  // Concurrent Request Isolation Tests
  // ============================================

  describe("Concurrent Request Isolation", () => {
    test("handles concurrent requests with different orgs", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");

      // Track which org made each request
      const orgRequests: string[] = [];

      mockOAuthService.listConnections.mockImplementation(async ({ organizationId }) => {
        orgRequests.push(organizationId);
        await new Promise((r) => setTimeout(r, Math.random() * 50));
        return [
          {
            id: `conn-${organizationId}`,
            status: "active",
            email: `user-${organizationId}@example.com`,
            scopes: [],
          },
        ];
      });

      let handler: any;
      const mockServer = {
        registerTool: (name: string, _schema: any, h: any) => {
          if (name === "google_status") handler = h;
        },
      };
      registerGoogleTools(mockServer as any);

      // Run concurrent requests with different orgs
      const results = await Promise.all([
        authContextStorage.run(createMockAuth("org-1"), async () => handler({})),
        authContextStorage.run(createMockAuth("org-2"), async () => handler({})),
        authContextStorage.run(createMockAuth("org-3"), async () => handler({})),
      ]);

      // All requests should succeed
      results.forEach((result) => {
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.connected).toBe(true);
      });

      // Each org should have been queried
      expect(orgRequests).toContain("org-1");
      expect(orgRequests).toContain("org-2");
      expect(orgRequests).toContain("org-3");
    });
  });

  // ============================================
  // Edge Cases & Boundary Conditions
  // ============================================

  describe("Edge Cases", () => {
    test("handles empty scopes array", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");

      mockOAuthService.listConnections.mockImplementation(async () => [
        { id: "conn-1", status: "active", email: "user@example.com", scopes: [] },
      ]);

      let handler: any;
      const mockServer = {
        registerTool: (name: string, _schema: any, h: any) => {
          if (name === "google_status") handler = h;
        },
      };
      registerGoogleTools(mockServer as any);

      const result = await authContextStorage.run(createMockAuth(), async () => {
        return handler({});
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.connected).toBe(true);
      expect(parsed.scopes).toEqual([]);
    });

    test("handles special characters in email subject", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");

      mockOAuthService.getValidTokenByPlatform.mockImplementation(async () => ({
        accessToken: "mock-token-123",
      }));

      let capturedBody: any;
      globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
        if (url.includes("gmail.googleapis.com")) {
          capturedBody = JSON.parse(init?.body as string);
          return new Response(JSON.stringify({ id: "msg-123", threadId: "thread-456" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("", { status: 404 });
      }) as typeof fetch;

      let handler: any;
      const mockServer = {
        registerTool: (name: string, _schema: any, h: any) => {
          if (name === "gmail_send") handler = h;
        },
      };
      registerGoogleTools(mockServer as any);

      await authContextStorage.run(createMockAuth(), async () => {
        return handler({
          to: "recipient@example.com",
          subject: "Test: Special chars & symbols <> \"quotes\"",
          body: "Body with émojis 🎉 and ünïcödé",
        });
      });

      // Verify message was encoded
      expect(capturedBody.raw).toBeDefined();
      const decoded = Buffer.from(capturedBody.raw, "base64").toString("utf-8");
      expect(decoded).toContain("Special chars");
    });

    test("handles network timeout gracefully", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");

      mockOAuthService.getValidTokenByPlatform.mockImplementation(async () => ({
        accessToken: "mock-token-123",
      }));

      globalThis.fetch = mock(async () => {
        throw new Error("Network request failed");
      }) as typeof fetch;

      let handler: any;
      const mockServer = {
        registerTool: (name: string, _schema: any, h: any) => {
          if (name === "gmail_list") handler = h;
        },
      };
      registerGoogleTools(mockServer as any);

      const result = await authContextStorage.run(createMockAuth(), async () => {
        return handler({});
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("Network request failed");
    });

    test("handles malformed API response", async () => {
      const { registerGoogleTools } = await import("@/app/api/mcp/tools/google");

      mockOAuthService.getValidTokenByPlatform.mockImplementation(async () => ({
        accessToken: "mock-token-123",
      }));

      globalThis.fetch = mock(async () => {
        return new Response("not json", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }) as typeof fetch;

      let handler: any;
      const mockServer = {
        registerTool: (name: string, _schema: any, h: any) => {
          if (name === "gmail_list") handler = h;
        },
      };
      registerGoogleTools(mockServer as any);

      const result = await authContextStorage.run(createMockAuth(), async () => {
        return handler({});
      });

      // Should error gracefully rather than crash
      expect(result.isError).toBe(true);
    });
  });
});
