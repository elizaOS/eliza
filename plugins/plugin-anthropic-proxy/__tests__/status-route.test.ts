import { describe, expect, it, vi } from "vitest";

vi.mock("../src/services/proxy-service.js", () => ({
  ANTHROPIC_PROXY_SERVICE_NAME: "anthropic_proxy_service",
}));

import { anthropicProxyRoutes } from "../src/routes/status-route";

interface CapturedResponse {
  statusCode: number;
  body: unknown;
}

function mockResponse(): { res: Record<string, unknown>; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 0, body: undefined };
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return {
        json(body: unknown) {
          captured.body = body;
        },
      };
    },
  };
  return { res, captured };
}

function mockRuntime(service: unknown) {
  return { getService: vi.fn(() => service) };
}

describe("anthropicProxyRoutes", () => {
  it("declares the GET status route with raw path handling", () => {
    expect(anthropicProxyRoutes).toHaveLength(1);
    expect(anthropicProxyRoutes[0]).toMatchObject({
      type: "GET",
      path: "/api/anthropic-proxy/status",
      rawPath: true,
    });
  });

  it("returns 503 when the proxy service is not loaded", async () => {
    const { res, captured } = mockResponse();
    await anthropicProxyRoutes[0].handler({}, res, mockRuntime(null));
    expect(captured.statusCode).toBe(503);
    expect(captured.body).toEqual({ error: "AnthropicProxyService not loaded" });
  });

  it("returns 200 with the service status when loaded", async () => {
    const { res, captured } = mockResponse();
    const service = {
      getStatus: vi.fn(async () => ({ mode: "relay", stats: null })),
    };
    await anthropicProxyRoutes[0].handler({}, res, mockRuntime(service));
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual({ mode: "relay", stats: null });
  });

  it("strips sensitive credential fields from stats on the health surface", async () => {
    const { res, captured } = mockResponse();
    const service = {
      getStatus: vi.fn(async () => ({
        mode: "direct",
        upstream: "claude",
        stats: {
          tokensIn: 12,
          tokensOut: 34,
          credsPath: "/var/secrets/creds.json",
          subscriptionType: "pro",
        },
      })),
    };
    await anthropicProxyRoutes[0].handler({}, res, mockRuntime(service));
    expect(captured.statusCode).toBe(200);
    const stats = (captured.body as { stats: Record<string, unknown> }).stats;
    expect(stats.tokensIn).toBe(12);
    expect(stats.tokensOut).toBe(34);
    expect(stats.credsPath).toBeUndefined();
    expect(stats.subscriptionType).toBeUndefined();
  });
});
