/**
 * Unit tests for BrowserBridgeRelayClient: URL joining, Bearer auth, and
 * RelayApiError mapping, driven against a mocked fetch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserBridgeRelayClient, type RelayApiError } from "./api-client";
import type {
  CompanionConfig,
  CompanionSessionCompleteRequest,
  CompanionSessionProgressRequest,
  CompanionSyncRequest,
} from "./protocol";

const config: CompanionConfig = {
  apiBaseUrl: "https://agent.example.com/root/",
  companionId: "companion-1",
  pairingToken: "pairing-token",
  pairingTokenExpiresAt: null,
  browser: "chrome",
  profileId: "default",
  profileLabel: "Default",
  label: "Agent Browser Bridge chrome Default",
};

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    status: 200,
    ...init,
  });
}

describe("BrowserBridgeRelayClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends sync requests with pairing headers and normalized endpoint URLs", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        settings: { enabled: true },
        sessions: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request: CompanionSyncRequest = {
      companion: {
        companionId: "companion-1",
        browser: "chrome",
        profileId: "default",
        profileLabel: "Default",
        label: "Agent Browser Bridge chrome Default",
      },
      tabs: [],
      activeTabId: null,
      capturedAt: "2026-01-01T00:00:00.000Z",
      extensionVersion: "1.0.0",
      permissions: [],
    };

    const client = new BrowserBridgeRelayClient(config);
    await expect(client.sync(request)).resolves.toMatchObject({
      settings: { enabled: true },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://agent.example.com/root/api/browser-bridge/companions/sync",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(request),
        headers: expect.objectContaining({
          Authorization: "Bearer pairing-token",
          "Content-Type": "application/json",
          "X-Browser-Bridge-Companion-Id": "companion-1",
        }),
      }),
    );
  });

  it("encodes session ids for progress and completion endpoints", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new BrowserBridgeRelayClient(config);
    const progress: CompanionSessionProgressRequest = {
      status: "running",
      note: "working",
      pageContext: null,
    };
    const completion: CompanionSessionCompleteRequest = {
      status: "completed",
      result: { ok: true },
      error: null,
    };

    await client.updateSessionProgress("session/one two", progress);
    await client.completeSession("session/one two", completion);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://agent.example.com/root/api/browser-bridge/companions/sessions/session%2Fone%20two/progress",
      "https://agent.example.com/root/api/browser-bridge/companions/sessions/session%2Fone%20two/complete",
    ]);
  });

  it("throws structured relay errors from error, message, and non-json responses", async () => {
    const client = new BrowserBridgeRelayClient(config);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { code: "PAIRING_EXPIRED", error: "Pairing expired" },
        { status: 401, statusText: "Unauthorized" },
      ),
    );
    await expect(client.sync({} as CompanionSyncRequest)).rejects.toMatchObject(
      {
        name: "RelayApiError",
        message: "Pairing expired",
        status: 401,
        code: "PAIRING_EXPIRED",
      } satisfies Partial<RelayApiError>,
    );

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { message: "Session missing" },
        { status: 404, statusText: "Not Found" },
      ),
    );
    await expect(
      client.updateSessionProgress(
        "missing",
        {} as CompanionSessionProgressRequest,
      ),
    ).rejects.toThrow("Session missing");

    fetchMock.mockResolvedValueOnce(
      new Response("not json", { status: 500, statusText: "Server Error" }),
    );
    await expect(
      client.completeSession("broken", {} as CompanionSessionCompleteRequest),
    ).rejects.toMatchObject({
      status: 500,
      code: null,
      message: "500 Server Error",
    });
  });
});
