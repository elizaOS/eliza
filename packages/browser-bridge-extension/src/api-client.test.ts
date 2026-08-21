/**
 * Unit tests for BrowserBridgeRelayClient: URL joining, Bearer auth, and
 * RelayApiError mapping, driven against a mocked fetch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserBridgeRelayClient, type RelayApiError } from "./api-client";
import type {
  CompanionConfig,
  CompanionSessionBeginRequest,
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

function syncResponse(overrides: Record<string, unknown> = {}) {
  return {
    companion: {
      id: config.companionId,
      browser: config.browser,
      profileId: config.profileId,
    },
    tabs: [],
    currentPage: null,
    settings: {
      enabled: true,
      trackingMode: "active_tabs",
      allowBrowserControl: true,
      requireConfirmationForAccountAffecting: true,
      incognitoEnabled: false,
      siteAccessMode: "all_sites",
      grantedOrigins: [],
      blockedOrigins: [],
      maxRememberedTabs: 10,
      pauseUntil: null,
      metadata: {},
      updatedAt: null,
    },
    session: null,
    settingsVersion: "settings-v1",
    ...overrides,
  };
}

describe("BrowserBridgeRelayClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends sync requests with pairing headers and normalized endpoint URLs", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(syncResponse()));
    vi.stubGlobal("fetch", fetchMock);

    const request: CompanionSyncRequest = {
      settingsVersion: "settings-v1",
      companion: {
        browser: "chrome",
        profileId: "default",
        profileLabel: "Default",
        label: "Agent Browser Bridge chrome Default",
      },
      tabs: [],
      pageContexts: [],
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

  it("preflights without browser data and rejects a data-bearing response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          companion: syncResponse().companion,
          settings: syncResponse().settings,
          settingsVersion: "settings-v1",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          companion: syncResponse().companion,
          settings: syncResponse().settings,
          settingsVersion: "settings-v1",
          tabs: [],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new BrowserBridgeRelayClient(config);
    const request = {
      companion: {
        browser: "chrome" as const,
        profileId: "default",
        label: config.label,
      },
    };
    await expect(client.preflight(request)).resolves.toMatchObject({
      settingsVersion: "settings-v1",
    });
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
    ).not.toHaveProperty("tabs");
    await expect(client.preflight(request)).rejects.toThrow("forbidden tabs");
  });

  it("rejects successful responses for a different companion", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          syncResponse({
            companion: {
              id: "attacker-companion",
              browser: config.browser,
              profileId: config.profileId,
            },
          }),
        ),
      ),
    );

    await expect(
      new BrowserBridgeRelayClient(config).sync({
        settingsVersion: "settings-v1",
      } as CompanionSyncRequest),
    ).rejects.toMatchObject({
      status: 502,
      code: "browser_bridge_response_invalid",
    });
  });

  it("rejects malformed actions before the service worker can execute them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          syncResponse({
            session: {
              id: "session-1",
              companionId: config.companionId,
              browser: config.browser,
              profileId: config.profileId,
              currentActionIndex: 0,
              actions: [{ id: "action-1", kind: "run_javascript" }],
            },
          }),
        ),
      ),
    );

    await expect(
      new BrowserBridgeRelayClient(config).sync({
        settingsVersion: "settings-v1",
      } as CompanionSyncRequest),
    ).rejects.toThrow("malformed action");
  });

  it("rejects cross-profile tabs, pages, stale versions, and malformed action controls", async () => {
    const client = new BrowserBridgeRelayClient(config);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        syncResponse({ tabs: [{ browser: "chrome", profileId: "other" }] }),
      ),
    );
    await expect(
      client.sync({ settingsVersion: "settings-v1" } as CompanionSyncRequest),
    ).rejects.toThrow("tab identity");
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        syncResponse({
          currentPage: { browser: "firefox", profileId: "default" },
        }),
      ),
    );
    await expect(
      client.sync({ settingsVersion: "settings-v1" } as CompanionSyncRequest),
    ).rejects.toThrow("currentPage identity");
    fetchMock.mockResolvedValueOnce(
      jsonResponse(syncResponse({ settingsVersion: "settings-v2" })),
    );
    await expect(
      client.sync({ settingsVersion: "settings-v1" } as CompanionSyncRequest),
    ).rejects.toThrow("settingsVersion does not match");
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        syncResponse({
          session: {
            id: "session-1",
            companionId: config.companionId,
            browser: config.browser,
            profileId: config.profileId,
            currentActionIndex: 0,
            actions: [
              {
                id: "action-1",
                kind: "click",
                label: "Click",
                browser: "firefox",
                windowId: null,
                tabId: null,
                url: null,
                selector: "button",
                text: null,
                accountAffecting: false,
                requiresConfirmation: false,
                metadata: {},
              },
            ],
          },
        }),
      ),
    );
    await expect(
      client.sync({ settingsVersion: "settings-v1" } as CompanionSyncRequest),
    ).rejects.toThrow("malformed action");
  });

  it("encodes session ids for progress and completion endpoints", async () => {
    const leasedSession = {
      id: "session/one two",
      companionId: config.companionId,
      browser: config.browser,
      profileId: config.profileId,
      currentActionIndex: 0,
      actions: [
        {
          id: "action-0",
          kind: "click",
          label: "Click",
          url: "https://allowed.example/",
          selector: "button",
          text: null,
          accountAffecting: false,
          requiresConfirmation: false,
          metadata: {},
        },
      ],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ session: leasedSession }))
      .mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new BrowserBridgeRelayClient(config);
    const begin: CompanionSessionBeginRequest = {
      actionId: "action-0",
      currentActionIndex: 0,
      attemptId: "attempt-0",
    };
    const progress: CompanionSessionProgressRequest = {
      completedActionId: "action-0",
      attemptId: "attempt-0",
      currentActionIndex: 1,
      result: { "action-0": { ok: true } },
    };
    const completion: CompanionSessionCompleteRequest = {
      status: "done",
      currentActionIndex: 1,
      completedActionId: "action-0",
      attemptId: "attempt-0",
      result: { ok: true },
    };

    await expect(
      client.beginSessionAction("session/one two", begin),
    ).resolves.toMatchObject({ id: "session/one two" });
    await client.updateSessionProgress("session/one two", progress);
    await client.completeSession("session/one two", completion);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://agent.example.com/root/api/browser-bridge/companions/sessions/session%2Fone%20two/actions/begin",
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
    await expect(
      client.sync({ settingsVersion: "settings-v1" } as CompanionSyncRequest),
    ).rejects.toMatchObject({
      name: "RelayApiError",
      message: "Pairing expired",
      status: 401,
      code: "PAIRING_EXPIRED",
    } satisfies Partial<RelayApiError>);

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
