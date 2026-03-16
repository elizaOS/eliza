import { describe, test, expect, vi } from "vitest";
import {
  createMockIncomingMessage,
  createMockHttpResponse,
} from "../../src/test-support/test-helpers";
import type { SubscriptionRouteContext } from "../../src/api/subscription-routes";
import { handleSubscriptionRoutes } from "../../src/api/subscription-routes";

function buildCtx(
  overrides: Partial<SubscriptionRouteContext> = {},
): SubscriptionRouteContext {
  const { res } = createMockHttpResponse();
  return {
    req: createMockIncomingMessage({ method: "GET", url: "/" }),
    res,
    method: "GET",
    pathname: "/",
    json: vi.fn((r, data, status = 200) => {
      r.writeHead(status);
      r.end(JSON.stringify(data));
    }),
    error: vi.fn((r, message, status = 500) => {
      r.writeHead(status);
      r.end(JSON.stringify({ error: message }));
    }),
    readJsonBody: vi.fn(async () => null),
    state: {
      config: {},
    },
    saveConfig: vi.fn(),
    loadSubscriptionAuth: vi.fn(async () => ({
      getSubscriptionStatus: vi.fn(() => ({ anthropic: "active" })),
      startAnthropicLogin: vi.fn(),
      startCodexLogin: vi.fn(),
      saveCredentials: vi.fn(),
      applySubscriptionCredentials: vi.fn(),
      deleteCredentials: vi.fn(),
    })),
    ...overrides,
  };
}

describe("handleSubscriptionRoutes", () => {
  test("returns false for unrelated path", async () => {
    const ctx = buildCtx({ pathname: "/api/other" });
    const handled = await handleSubscriptionRoutes(ctx);
    expect(handled).toBe(false);
  });

  test("GET /api/subscription/status returns provider status", async () => {
    const { res, getStatus, getJson } = createMockHttpResponse();
    const providerStatuses = { anthropic: "active", openai: "inactive" };
    const ctx = buildCtx({
      method: "GET",
      pathname: "/api/subscription/status",
      res,
      loadSubscriptionAuth: vi.fn(async () => ({
        getSubscriptionStatus: vi.fn(() => providerStatuses),
        startAnthropicLogin: vi.fn(),
        startCodexLogin: vi.fn(),
        saveCredentials: vi.fn(),
        applySubscriptionCredentials: vi.fn(),
        deleteCredentials: vi.fn(),
      })),
    });

    const handled = await handleSubscriptionRoutes(ctx);

    expect(handled).toBe(true);
    expect(getStatus()).toBe(200);
    expect(getJson()).toEqual({ providers: providerStatuses });
  });

  test("GET /api/subscription/status returns 500 when loadSubscriptionAuth throws", async () => {
    const { res, getStatus } = createMockHttpResponse();
    const ctx = buildCtx({
      method: "GET",
      pathname: "/api/subscription/status",
      res,
      loadSubscriptionAuth: vi.fn(async () => {
        throw new Error("auth module unavailable");
      }),
    });

    const handled = await handleSubscriptionRoutes(ctx);

    expect(handled).toBe(true);
    expect(getStatus()).toBe(500);
  });
});
