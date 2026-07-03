// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
  },
  CapacitorHttp: {
    get: vi.fn(),
    post: vi.fn(),
    request: vi.fn(),
  },
}));

import { setBootConfig } from "../config/boot-config";
import { ElizaClient } from "./client-base";
import "./client-cloud";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ElizaClient direct Cloud auth on hosted web", () => {
  beforeEach(() => {
    setBootConfig({
      branding: {},
      cloudApiBase: "https://staging.elizacloud.ai",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates CLI sessions through the same-origin proxy and opens staging auth", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ ok: true }));

    const client = new ElizaClient("http://localhost:31337");
    const result = await client.cloudLoginDirect(
      "https://staging.elizacloud.ai",
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/auth/cli-session",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: expect.stringContaining("sessionId"),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        apiBase: "https://api-staging.elizacloud.ai",
        sessionId: expect.any(String),
        browserUrl: expect.stringMatching(
          /^https:\/\/staging\.elizacloud\.ai\/auth\/cli-login\?session=/,
        ),
      }),
    );
  });

  it("polls CLI sessions through the same-origin proxy", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        status: "authenticated",
        apiKey: "cloud-api-key",
        organizationId: "org-1",
        userId: "user-1",
      }),
    );

    const client = new ElizaClient("http://localhost:31337");
    const result = await client.cloudLoginPollDirect(
      "https://api-staging.elizacloud.ai",
      "session-1",
    );

    expect(fetchSpy).toHaveBeenCalledWith("/api/auth/cli-session/session-1");
    expect(result).toEqual({
      status: "authenticated",
      organizationId: "org-1",
      token: "cloud-api-key",
      userId: "user-1",
    });
  });

  it("routes direct Cloud API calls through same-origin /api/v1", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        success: true,
        data: { id: "user-1", organization_id: "org-1" },
      }),
    );

    const client = new ElizaClient(
      "https://api-staging.elizacloud.ai",
      "cloud-api-key",
    );
    const result = await client.getCloudStatus();

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/v1/user",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer cloud-api-key",
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        connected: true,
        userId: "user-1",
        organizationId: "org-1",
      }),
    );
  });
});
