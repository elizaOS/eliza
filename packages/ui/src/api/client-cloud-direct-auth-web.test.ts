// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://app.elizacloud.ai/" }

/**
 * Unit coverage for direct-Cloud auth on hosted web (non-native path). Capacitor
 * forced to web + CapacitorHttp mocked, fetch stubbed, no live cloud.
 *
 * Two origins are exercised because the same-origin collapse in
 * `resolveBrowserCloudApiRequestUrl` is only valid when the page is served from a
 * cloud host: the file default (`app.elizacloud.ai`) proves the co-hosted proxy
 * path, and the `localhost` block proves the dev path, where the request must
 * stay an absolute cloud URL on shifted Vite ports.
 */

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

const originalLocationDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "location",
);

function stubPageHostname(hostname: string, port: string): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...window.location,
      protocol: "http:",
      hostname,
      port,
      host: `${hostname}:${port}`,
      origin: `http://${hostname}:${port}`,
      href: `http://${hostname}:${port}/chat?onboarding=1`,
      pathname: "/chat",
      search: "?onboarding=1",
      hash: "",
    },
  });
}

function restorePageLocation(): void {
  if (originalLocationDescriptor) {
    Object.defineProperty(window, "location", originalLocationDescriptor);
  }
}

describe("ElizaClient direct Cloud auth served from a cloud web host", () => {
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

describe("ElizaClient direct Cloud auth served from localhost dev (port-shift)", () => {
  beforeEach(() => {
    setBootConfig({
      branding: {},
      cloudApiBase: "https://staging.elizacloud.ai",
    });
    // The orchestrator shifts the Vite UI port when the default is taken; cloud
    // auth must still reach the cloud worker.
    stubPageHostname("localhost", "2160");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restorePageLocation();
  });

  it("creates CLI sessions against the absolute cloud URL, not the local agent", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ ok: true }));

    const client = new ElizaClient("http://localhost:31337");
    const result = await client.cloudLoginDirect(
      "https://staging.elizacloud.ai",
    );

    // The bug: a same-origin "/api/auth/cli-session" gets proxied to the local
    // agent API, whose default-deny gate 401s the unlisted /api/auth/* path.
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api-staging.elizacloud.ai/api/auth/cli-session",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchSpy).not.toHaveBeenCalledWith(
      "/api/auth/cli-session",
      expect.anything(),
    );
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        apiBase: "https://api-staging.elizacloud.ai",
      }),
    );
    const browserUrl = new URL(result.browserUrl ?? "");
    expect(browserUrl.origin).toBe("https://staging.elizacloud.ai");
    expect(browserUrl.pathname).toBe("/auth/cli-login");
    const sessionId = browserUrl.searchParams.get("session");
    expect(sessionId).toEqual(expect.any(String));
    const returnTo = new URL(browserUrl.searchParams.get("returnTo") ?? "");
    expect(returnTo.origin).toBe("http://localhost:2160");
    expect(returnTo.pathname).toBe("/chat");
    expect(returnTo.searchParams.get("onboarding")).toBe("1");
    expect(returnTo.searchParams.get("elizaCloudLogin")).toBe("complete");
    expect(returnTo.searchParams.get("elizaCloudLoginSession")).toBe(sessionId);
  });

  it("polls CLI sessions against the absolute cloud URL", async () => {
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

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api-staging.elizacloud.ai/api/auth/cli-session/session-1",
    );
    expect(result).toEqual({
      status: "authenticated",
      organizationId: "org-1",
      token: "cloud-api-key",
      userId: "user-1",
    });
  });

  it("prefers direct Cloud session tokens over legacy apiKey fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        status: "authenticated",
        apiKey: "legacy-api-key",
        token: "fresh-session-token",
        organization_id: "org-snake",
        user_id: "user-snake",
      }),
    );

    const client = new ElizaClient("http://localhost:31337");
    const result = await client.cloudLoginPollDirect(
      "https://api-staging.elizacloud.ai",
      "session-1",
    );

    expect(result).toEqual({
      status: "authenticated",
      organizationId: "org-snake",
      token: "fresh-session-token",
      userId: "user-snake",
    });
  });
});
