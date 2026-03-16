/**
 * MCP Lib Unit Tests
 * Tests for app/api/mcp/lib/ helpers
 */

import { describe, test, expect } from "bun:test";
import { jsonResponse, errorResponse } from "@/app/api/mcp/lib/responses";
import { authContextStorage, getAuthContext } from "@/app/api/mcp/lib/context";

describe("jsonResponse", () => {
  test("wraps data in MCP content format", () => {
    const result = jsonResponse({ foo: "bar" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
  });

  test("serializes object to JSON string", () => {
    const result = jsonResponse({ count: 42 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(42);
  });

  test("pretty prints with 2 spaces", () => {
    const result = jsonResponse({ a: 1 });
    expect(result.content[0].text).toContain("\n");
  });

  test("handles nested objects", () => {
    const result = jsonResponse({ user: { name: "test", id: 123 } });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.user.name).toBe("test");
  });

  test("handles arrays", () => {
    const result = jsonResponse([1, 2, 3]);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual([1, 2, 3]);
  });

  test("handles null", () => {
    const result = jsonResponse(null);
    expect(result.content[0].text).toBe("null");
  });
});

describe("errorResponse", () => {
  test("sets isError to true", () => {
    const result = errorResponse("Something failed");
    expect(result.isError).toBe(true);
  });

  test("includes error message in content", () => {
    const result = errorResponse("Connection timeout");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("Connection timeout");
  });

  test("merges details into response", () => {
    const result = errorResponse("Failed", { code: 500, reason: "timeout" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("Failed");
    expect(parsed.code).toBe(500);
    expect(parsed.reason).toBe("timeout");
  });

  test("handles undefined details", () => {
    const result = errorResponse("Error");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("Error");
  });
});

describe("authContextStorage", () => {
  test("is an AsyncLocalStorage instance", () => {
    expect(authContextStorage).toBeDefined();
    expect(typeof authContextStorage.run).toBe("function");
    expect(typeof authContextStorage.getStore).toBe("function");
  });

  test("run() executes callback with context", async () => {
    const mockAuth = {
      user: {
        id: "user-123",
        organization_id: "org-456",
        organization: { id: "org-456", name: "Test Org" },
      },
    } as any;

    let capturedContext: any;
    await authContextStorage.run(mockAuth, async () => {
      capturedContext = authContextStorage.getStore();
    });

    expect(capturedContext).toBe(mockAuth);
  });

  test("context is isolated between runs", async () => {
    const auth1 = { user: { id: "user-1" } } as any;
    const auth2 = { user: { id: "user-2" } } as any;

    const results: string[] = [];

    await Promise.all([
      authContextStorage.run(auth1, async () => {
        await new Promise((r) => setTimeout(r, 10));
        results.push(authContextStorage.getStore()?.user.id);
      }),
      authContextStorage.run(auth2, async () => {
        results.push(authContextStorage.getStore()?.user.id);
      }),
    ]);

    expect(results).toContain("user-1");
    expect(results).toContain("user-2");
  });
});

describe("getAuthContext", () => {
  test("throws when called outside context", () => {
    expect(() => getAuthContext()).toThrow(
      "Authentication context not available",
    );
  });

  test("returns context when inside run()", async () => {
    const mockAuth = {
      user: {
        id: "test-user",
        organization_id: "test-org",
        organization: { id: "test-org", name: "Test" },
      },
    } as any;

    let result: any;
    await authContextStorage.run(mockAuth, async () => {
      result = getAuthContext();
    });

    expect(result.user.id).toBe("test-user");
  });
});
