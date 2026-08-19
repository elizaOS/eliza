/** Verifies ElizaClient direct Cloud auth served from a cloud web host through the package's configured test harness. */
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

const runtimeMocks = vi.hoisted(() => ({ electrobun: false }));

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

vi.mock("../bridge/electrobun-runtime", () => ({
  isElectrobunRuntime: () => runtimeMocks.electrobun,
}));

import { setBootConfig } from "../config/boot-config";
import { ElizaClient } from "./client-base";
import "./client-cloud";
import {
  STAGING_DIRECT_CLOUD_API_BASE_URL,
  STAGING_DIRECT_CLOUD_BASE_URL,
} from "./direct-cloud-endpoints";

const SERVER_SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
      .mockResolvedValue(jsonResponse({ sessionId: SERVER_SESSION_ID }, 201));

    const client = new ElizaClient("http://localhost:31337");
    const result = await client.cloudLoginDirect(
      "https://staging.elizacloud.ai",
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/auth/cli-session",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: expect.any(String),
      }),
    );
    const requestBody = JSON.parse(
      String(fetchSpy.mock.calls[0]?.[1]?.body),
    ) as { sessionId?: unknown };
    expect(requestBody.sessionId).toEqual(expect.stringMatching(UUID_V4_RE));
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        apiBase: STAGING_DIRECT_CLOUD_API_BASE_URL,
        sessionId: SERVER_SESSION_ID,
        browserUrl: expect.stringMatching(
          new RegExp(
            `^${STAGING_DIRECT_CLOUD_BASE_URL}/auth/cli-login\\?session=`,
          ),
        ),
      }),
    );
  });

  it.each([{}, { sessionId: "not-a-uuid" }])(
    "rejects a successful web response without a server-issued UUID",
    async (body) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(body, 201));

      const client = new ElizaClient("http://localhost:31337");
      const result = await client.cloudLoginDirect(
        "https://staging.elizacloud.ai",
      );

      expect(result).toEqual({
        ok: false,
        error: "Login failed: Eliza Cloud returned an invalid session ID",
      });
    },
  );

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
    runtimeMocks.electrobun = false;
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
      .mockResolvedValue(jsonResponse({ sessionId: SERVER_SESSION_ID }, 201));

    const client = new ElizaClient("http://localhost:31337");
    const result = await client.cloudLoginDirect(
      "https://staging.elizacloud.ai",
    );

    // The bug: a same-origin "/api/auth/cli-session" gets proxied to the local
    // agent API, whose default-deny gate 401s the unlisted /api/auth/* path.
    expect(fetchSpy).toHaveBeenCalledWith(
      `${STAGING_DIRECT_CLOUD_API_BASE_URL}/api/auth/cli-session`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchSpy).not.toHaveBeenCalledWith(
      "/api/auth/cli-session",
      expect.anything(),
    );
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        apiBase: STAGING_DIRECT_CLOUD_API_BASE_URL,
      }),
    );
    const browserUrl = new URL(result.browserUrl ?? "");
    expect(browserUrl.origin).toBe(STAGING_DIRECT_CLOUD_BASE_URL);
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
      `${STAGING_DIRECT_CLOUD_API_BASE_URL}/api/auth/cli-session/session-1`,
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

describe("ElizaClient direct Cloud auth served from Electrobun", () => {
  beforeEach(() => {
    runtimeMocks.electrobun = true;
    setBootConfig({
      branding: {},
      cloudApiBase: "https://staging.elizacloud.ai",
    });
    stubPageHostname("127.0.0.1", "5174");
  });

  afterEach(() => {
    runtimeMocks.electrobun = false;
    vi.restoreAllMocks();
    restorePageLocation();
  });

  it("keeps the browser callback out of the loopback renderer", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ sessionId: SERVER_SESSION_ID }, 201),
    );

    const client = new ElizaClient("http://127.0.0.1:31337");
    const result = await client.cloudLoginDirect(
      "https://staging.elizacloud.ai",
    );

    const browserUrl = new URL(result.browserUrl ?? "");
    expect(browserUrl.origin).toBe(STAGING_DIRECT_CLOUD_BASE_URL);
    expect(browserUrl.pathname).toBe("/auth/cli-login");
    expect(result.sessionId).toBe(SERVER_SESSION_ID);
    expect(browserUrl.searchParams.get("session")).toBe(SERVER_SESSION_ID);
    expect(browserUrl.searchParams.has("returnTo")).toBe(false);
  });
});
