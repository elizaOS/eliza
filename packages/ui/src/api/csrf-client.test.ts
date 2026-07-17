// @vitest-environment jsdom

/**
 * Unit coverage for the CSRF-token fetch wrapper. Boot config mocked, no live
 * server.
 */
import { setBootConfig as setSharedBootConfig } from "@elizaos/shared/config/boot-config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bootConfigMock = vi.hoisted(() => ({
  getBootConfig: vi.fn(),
}));

const localAgentTokenMock = vi.hoisted(() => ({
  hydrateAndroidLocalAgentTokenForUrl: vi.fn(),
}));

const androidTransportMock = vi.hoisted(() => ({
  androidNativeAgentTransportForUrl: vi.fn(),
}));

const iosTransportMock = vi.hoisted(() => ({
  iosInProcessAgentTransportForUrl: vi.fn(),
}));

const desktopLocalTransportMock = vi.hoisted(() => ({
  desktopLocalAgentTransportForUrl: vi.fn(),
}));

const desktopTransportMock = vi.hoisted(() => ({
  desktopHttpTransportForUrl: vi.fn(),
}));

const nativeCloudTransportMock = vi.hoisted(() => ({
  nativeCloudHttpTransportForUrl: vi.fn(),
}));

const fetchTransportMock = vi.hoisted(() => ({
  fetchAgentTransport: {
    request: vi.fn(),
  },
}));

vi.mock("../config/boot-config", () => bootConfigMock);
vi.mock("../first-run/local-agent-token", () => localAgentTokenMock);
vi.mock("./android-native-agent-transport", () => androidTransportMock);
vi.mock("./ios-local-agent-transport", () => iosTransportMock);
vi.mock("./desktop-local-agent-transport", () => desktopLocalTransportMock);
vi.mock("./desktop-http-transport", () => desktopTransportMock);
vi.mock("./native-cloud-http-transport", () => nativeCloudTransportMock);
vi.mock("./transport", () => fetchTransportMock);

import {
  fetchWithCsrf,
  readCsrfTokenFromCookie,
  requestViaAgentTransport,
} from "./csrf-client";

function clearCookie(name: string) {
  document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
}

describe("fetchWithCsrf", () => {
  beforeEach(() => {
    clearCookie("eliza_csrf");
    clearCookie("other");
    bootConfigMock.getBootConfig.mockReturnValue({ apiToken: null });
    localAgentTokenMock.hydrateAndroidLocalAgentTokenForUrl.mockResolvedValue(
      undefined,
    );
    androidTransportMock.androidNativeAgentTransportForUrl.mockResolvedValue(
      null,
    );
    iosTransportMock.iosInProcessAgentTransportForUrl.mockResolvedValue(null);
    desktopLocalTransportMock.desktopLocalAgentTransportForUrl.mockResolvedValue(
      null,
    );
    desktopTransportMock.desktopHttpTransportForUrl.mockReturnValue(null);
    nativeCloudTransportMock.nativeCloudHttpTransportForUrl.mockReturnValue(
      null,
    );
    fetchTransportMock.fetchAgentTransport.request.mockResolvedValue(
      new Response("{}", { status: 200 }),
    );
  });

  afterEach(() => {
    clearCookie("eliza_csrf");
    clearCookie("other");
    setSharedBootConfig({ branding: {} });
    vi.clearAllMocks();
  });

  it("reads the decoded CSRF token from a semicolon-separated cookie string", () => {
    document.cookie = "other=value";
    document.cookie = "eliza_csrf=token%3Dwith%3Bencoded%20parts";

    expect(readCsrfTokenFromCookie()).toBe("token=with;encoded parts");
  });

  it("returns null when the CSRF cookie is absent", () => {
    document.cookie = "other=value";

    expect(readCsrfTokenFromCookie()).toBeNull();
  });

  it("mirrors the CSRF cookie only on state-changing requests", async () => {
    document.cookie = "eliza_csrf=csrf-post-token";

    await fetchWithCsrf("/api/things", { method: "POST" });
    const postHeaders = fetchTransportMock.fetchAgentTransport.request.mock
      .calls[0]?.[1].headers as Headers;
    expect(postHeaders.get("x-eliza-csrf")).toBe("csrf-post-token");

    await fetchWithCsrf("/api/things", { method: "GET" });
    const getHeaders = fetchTransportMock.fetchAgentTransport.request.mock
      .calls[1]?.[1].headers as Headers;
    expect(getHeaders.has("x-eliza-csrf")).toBe(false);
  });

  it("attaches a trimmed boot bearer without replacing an explicit Authorization header", async () => {
    bootConfigMock.getBootConfig.mockReturnValue({
      apiToken: "  boot-token  ",
    });

    await fetchWithCsrf("/api/no-explicit-auth");
    let headers = fetchTransportMock.fetchAgentTransport.request.mock
      .calls[0]?.[1].headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer boot-token");

    await fetchWithCsrf("/api/explicit-auth", {
      headers: { Authorization: "Bearer caller-token" },
    });
    headers = fetchTransportMock.fetchAgentTransport.request.mock.calls[1]?.[1]
      .headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer caller-token");
    expect(
      localAgentTokenMock.hydrateAndroidLocalAgentTokenForUrl,
    ).toHaveBeenCalledTimes(1);
  });

  it("routes external desktop HTTP auth requests through the desktop transport", async () => {
    bootConfigMock.getBootConfig.mockReturnValue({ apiToken: "secret-token" });
    const transport = {
      request: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
    };
    desktopTransportMock.desktopHttpTransportForUrl.mockReturnValue(transport);

    const response = await fetchWithCsrf(
      "http://147.93.44.246:2138/api/auth/me",
    );

    expect(response.status).toBe(200);
    expect(
      desktopTransportMock.desktopHttpTransportForUrl,
    ).toHaveBeenCalledWith("http://147.93.44.246:2138/api/auth/me");
    expect(transport.request).toHaveBeenCalledWith(
      "http://147.93.44.246:2138/api/auth/me",
      expect.objectContaining({
        credentials: "include",
        headers: expect.any(Headers),
      }),
      { timeoutMs: 10_000 },
    );
    const headers = transport.request.mock.calls[0][1].headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer secret-token");
  });

  it("resolves relative API paths against the configured apiBase (remote mobile)", async () => {
    bootConfigMock.getBootConfig.mockReturnValue({
      apiToken: "secret-token",
      apiBase: "http://127.0.0.1:41337",
    });
    setSharedBootConfig({
      branding: {},
      apiBase: "http://127.0.0.1:41337",
    });
    const transport = {
      request: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
    };
    desktopTransportMock.desktopHttpTransportForUrl.mockReturnValue(transport);

    await fetchWithCsrf("/api/apps/favorites");

    expect(
      desktopTransportMock.desktopHttpTransportForUrl,
    ).toHaveBeenCalledWith("http://127.0.0.1:41337/api/apps/favorites");
  });

  it("never rewrites an already-absolute URL even with an apiBase configured", async () => {
    bootConfigMock.getBootConfig.mockReturnValue({
      apiToken: "secret-token",
      apiBase: "http://127.0.0.1:41337",
    });
    setSharedBootConfig({
      branding: {},
      apiBase: "http://127.0.0.1:41337",
    });
    const transport = {
      request: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
    };
    desktopTransportMock.desktopHttpTransportForUrl.mockReturnValue(transport);

    await fetchWithCsrf("http://127.0.0.1:41337/api/auth/me");

    expect(
      desktopTransportMock.desktopHttpTransportForUrl,
    ).toHaveBeenCalledWith("http://127.0.0.1:41337/api/auth/me");
  });

  it("passes the long message timeout through CSRF desktop transport calls", async () => {
    bootConfigMock.getBootConfig.mockReturnValue({ apiToken: null });
    const transport = {
      request: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
    };
    desktopTransportMock.desktopHttpTransportForUrl.mockReturnValue(transport);

    await fetchWithCsrf(
      "http://147.93.44.246:2138/api/conversations/id/messages?agentId=agent",
      { method: "POST" },
    );

    expect(transport.request).toHaveBeenCalledWith(
      "http://147.93.44.246:2138/api/conversations/id/messages?agentId=agent",
      expect.objectContaining({ method: "POST" }),
      { timeoutMs: 600_000 },
    );
  });

  it("selects the first available platform transport in canonical order", async () => {
    const androidTransport = {
      request: vi.fn().mockResolvedValue(new Response("android")),
    };
    const iosTransport = {
      request: vi.fn().mockResolvedValue(new Response("ios")),
    };
    androidTransportMock.androidNativeAgentTransportForUrl.mockResolvedValue(
      androidTransport,
    );
    iosTransportMock.iosInProcessAgentTransportForUrl.mockResolvedValue(
      iosTransport,
    );

    const response = await requestViaAgentTransport(
      "https://api.elizacloud.ai/api/tts/cloud",
      { method: "POST" },
      { responseType: "arraybuffer", timeoutMs: 1234 },
    );

    expect(await response.text()).toBe("android");
    expect(androidTransport.request).toHaveBeenCalledWith(
      "https://api.elizacloud.ai/api/tts/cloud",
      { method: "POST" },
      { responseType: "arraybuffer", timeoutMs: 1234 },
    );
    expect(iosTransport.request).not.toHaveBeenCalled();
  });

  it("does not hide a selected transport failure by trying a later fallback", async () => {
    const selectedError = new Error("native bridge failed");
    const selectedTransport = {
      request: vi.fn().mockRejectedValue(selectedError),
    };
    const fallbackTransport = {
      request: vi.fn().mockResolvedValue(new Response("fallback")),
    };
    desktopLocalTransportMock.desktopLocalAgentTransportForUrl.mockResolvedValue(
      selectedTransport,
    );
    desktopTransportMock.desktopHttpTransportForUrl.mockReturnValue(
      fallbackTransport,
    );

    await expect(
      requestViaAgentTransport("http://127.0.0.1:2138/api/tts/cloud", {
        method: "POST",
      }),
    ).rejects.toThrow("native bridge failed");
    expect(fallbackTransport.request).not.toHaveBeenCalled();
  });

  it("falls back to fetch transport with the computed timeout and forwards responseType", async () => {
    fetchTransportMock.fetchAgentTransport.request.mockResolvedValueOnce(
      new Response("ok"),
    );

    await requestViaAgentTransport(
      "/api/tts/local-inference",
      { method: "POST" },
      { responseType: "arraybuffer" },
    );

    expect(fetchTransportMock.fetchAgentTransport.request).toHaveBeenCalledWith(
      "/api/tts/local-inference",
      { method: "POST" },
      { responseType: "arraybuffer", timeoutMs: 180_000 },
    );
  });
});
