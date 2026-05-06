import { describe, expect, it, vi } from "vitest";

const bootConfigMock = vi.hoisted(() => ({
  getBootConfig: vi.fn(),
}));

const desktopTransportMock = vi.hoisted(() => ({
  desktopHttpTransportForUrl: vi.fn(),
}));

vi.mock("../config/boot-config", () => bootConfigMock);
vi.mock("./desktop-http-transport", () => desktopTransportMock);

import { fetchWithCsrf } from "./csrf-client";

describe("fetchWithCsrf", () => {
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
      { timeoutMs: 300_000 },
    );
  });
});
