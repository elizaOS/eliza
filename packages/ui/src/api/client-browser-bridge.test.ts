/**
 * Verifies the ElizaClient browser-bridge extension against plugin-browser's
 * wire contracts: route paths, verbs, JSON bodies, id percent-encoding, and
 * passthrough of untransformed payloads. Transport stubbed deterministically;
 * no live server or companion extension is involved.
 */
import { describe, expect, it, vi } from "vitest";
import type { UpdateBrowserBridgeSettingsRequest } from "./browser-contracts";
import { ElizaClient } from "./client-base";
import { BROWSER_BRIDGE_SESSION_STATUSES } from "./client-browser-bridge";
import "./client-browser-bridge";
import type { AgentRequestTransport } from "./transport";

function makeClient(responses: Record<string, unknown>): {
  client: ElizaClient;
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn<AgentRequestTransport["request"]>(async (url) => {
    const parsed = new URL(url);
    const key = `${parsed.pathname}${parsed.search}`;
    if (!(key in responses)) {
      throw new Error(`unexpected browser-bridge request: ${key}`);
    }
    return Response.json(responses[key]);
  });
  const client = new ElizaClient("http://agent.example:31337", "token");
  client.setRequestTransport({ request });
  return { client, request };
}

function sessionFixture(
  status: (typeof BROWSER_BRIDGE_SESSION_STATUSES)[number],
) {
  return {
    id: "session-1",
    agentId: "agent-1",
    domain: "example.com",
    workflowId: null,
    browser: "chrome",
    companionId: "companion-1",
    profileId: "profile-1",
    windowId: "window-1",
    tabId: "tab-1",
    title: "Research flight prices",
    status,
    actions: [
      {
        id: "action-1",
        kind: "navigate",
        label: "Open flights page",
        url: "https://example.com/flights",
        selector: null,
        text: null,
        accountAffecting: false,
        requiresConfirmation: false,
        metadata: {},
      },
      {
        id: "action-2",
        kind: "click",
        label: "Book economy fare",
        url: null,
        selector: "#book-button",
        text: "Book",
        accountAffecting: true,
        requiresConfirmation: true,
        metadata: { step: 2 },
      },
    ],
    currentActionIndex: 0,
    awaitingConfirmationForActionId: null,
    result: {},
    metadata: {},
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:01:00.000Z",
    finishedAt: null,
  };
}

describe("ElizaClient browser-bridge routes", () => {
  it("lists bridge sessions without transforming the wire payload", async () => {
    const session = sessionFixture("awaiting_confirmation");
    expect(BROWSER_BRIDGE_SESSION_STATUSES).toContain(session.status);
    const payload = { sessions: [session] };
    const { client, request } = makeClient({
      "/api/browser-bridge/sessions": payload,
    });

    await expect(client.listBrowserBridgeSessions()).resolves.toEqual(payload);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:31337/api/browser-bridge/sessions",
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("returns every queued-to-failed status unchanged through the list endpoint", async () => {
    const payload = {
      sessions: [
        sessionFixture("queued"),
        sessionFixture("running"),
        sessionFixture("done"),
        sessionFixture("cancelled"),
        sessionFixture("failed"),
      ],
    };
    const { client } = makeClient({
      "/api/browser-bridge/sessions": payload,
    });

    const listed = await client.listBrowserBridgeSessions();
    expect(listed.sessions.map((entry) => entry.status)).toEqual([
      "queued",
      "running",
      "done",
      "cancelled",
      "failed",
    ]);
  });

  it("reads the bridge domain-policy settings verbatim", async () => {
    const payload = {
      settings: {
        enabled: true,
        trackingMode: "current_tab",
        allowBrowserControl: true,
        requireConfirmationForAccountAffecting: true,
        incognitoEnabled: false,
        siteAccessMode: "granted_sites",
        grantedOrigins: ["https://example.com"],
        blockedOrigins: [],
        maxRememberedTabs: 12,
        pauseUntil: null,
        metadata: {},
        updatedAt: "2026-08-24T00:00:00.000Z",
      },
    };
    const { client, request } = makeClient({
      "/api/browser-bridge/settings": payload,
    });

    await expect(client.getBrowserBridgeSettings()).resolves.toEqual(payload);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:31337/api/browser-bridge/settings",
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("posts the update request JSON-encoded to the settings endpoint", async () => {
    const update: UpdateBrowserBridgeSettingsRequest = {
      enabled: false,
      trackingMode: "active_tabs",
      allowBrowserControl: false,
      requireConfirmationForAccountAffecting: true,
      siteAccessMode: "all_sites",
      grantedOrigins: ["https://a.example", "https://b.example"],
      blockedOrigins: ["https://blocked.example"],
      maxRememberedTabs: 5,
      pauseUntil: "2026-08-25T09:00:00.000Z",
      metadata: { reason: "user-pause" },
    };
    const payload = {
      settings: {
        enabled: false,
        trackingMode: "active_tabs",
        allowBrowserControl: false,
        requireConfirmationForAccountAffecting: true,
        incognitoEnabled: false,
        siteAccessMode: "all_sites",
        grantedOrigins: ["https://a.example", "https://b.example"],
        blockedOrigins: ["https://blocked.example"],
        maxRememberedTabs: 5,
        pauseUntil: "2026-08-25T09:00:00.000Z",
        metadata: { reason: "user-pause" },
        updatedAt: "2026-08-24T00:02:00.000Z",
      },
    };
    const { client, request } = makeClient({
      "/api/browser-bridge/settings": payload,
    });

    await expect(client.updateBrowserBridgeSettings(update)).resolves.toEqual(
      payload,
    );
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:31337/api/browser-bridge/settings",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(update),
      }),
      expect.any(Object),
    );
  });

  it("confirms an awaiting session and percent-encodes the id into one segment", async () => {
    const payload = { session: sessionFixture("queued") };
    const { client, request } = makeClient({
      "/api/browser-bridge/sessions/sess%2F1%3Fx%3D1%26y%3D2/confirm": payload,
    });

    await expect(
      client.confirmBrowserBridgeSession("sess/1?x=1&y=2", true),
    ).resolves.toEqual(payload);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:31337/api/browser-bridge/sessions/sess%2F1%3Fx%3D1%26y%3D2/confirm",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ confirmed: true }),
      }),
      expect.any(Object),
    );
  });

  it("declines a session with an explicit confirmed=false body", async () => {
    const payload = { session: sessionFixture("cancelled") };
    const { client, request } = makeClient({
      "/api/browser-bridge/sessions/session-9/confirm": payload,
    });

    await expect(
      client.confirmBrowserBridgeSession("session-9", false),
    ).resolves.toEqual(payload);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:31337/api/browser-bridge/sessions/session-9/confirm",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ confirmed: false }),
      }),
      expect.any(Object),
    );
  });

  it("lists companions preserving server order across connection states", async () => {
    function companion(
      id: string,
      browser: "chrome" | "firefox" | "safari",
      connectionState: string,
    ) {
      return {
        id,
        agentId: "agent-1",
        browser,
        profileId: `${id}-profile`,
        profileLabel: "Default",
        label: `${browser} companion`,
        extensionVersion: "1.2.3",
        connectionState,
        permissions: {
          tabs: true,
          scripting: true,
          activeTab: true,
          allOrigins: false,
          grantedOrigins: ["https://example.com"],
          incognitoEnabled: false,
        },
        lastSeenAt: "2026-08-24T00:00:30.000Z",
        pairedAt: "2026-08-23T12:00:00.000Z",
        metadata: {},
        createdAt: "2026-08-23T12:00:00.000Z",
        updatedAt: "2026-08-24T00:00:30.000Z",
      };
    }
    const payload = {
      companions: [
        companion("companion-a", "chrome", "connected"),
        companion("companion-b", "firefox", "permission_blocked"),
      ],
    };
    const { client, request } = makeClient({
      "/api/browser-bridge/companions": payload,
    });

    const listed = await client.listBrowserBridgeCompanions();
    expect(listed.companions.map((entry) => entry.id)).toEqual([
      "companion-a",
      "companion-b",
    ]);
    expect(listed).toEqual(payload);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:31337/api/browser-bridge/companions",
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("resets a revoked companion via POST without a request body", async () => {
    const payload = {
      companion: {
        id: "companion rev &x=y",
        agentId: "agent-1",
        browser: "safari",
        profileId: "profile-1",
        profileLabel: "Default",
        label: "Safari companion",
        extensionVersion: null,
        connectionState: "disconnected",
        permissions: {
          tabs: false,
          scripting: false,
          activeTab: false,
          allOrigins: false,
          grantedOrigins: [],
          incognitoEnabled: false,
        },
        lastSeenAt: null,
        pairedAt: "2026-08-20T08:00:00.000Z",
        metadata: {},
        createdAt: "2026-08-20T08:00:00.000Z",
        updatedAt: "2026-08-24T00:03:00.000Z",
      },
      resetAt: "2026-08-24T00:03:00.000Z",
    };
    const { client, request } = makeClient({
      "/api/browser-bridge/companions/companion%20rev%20%26x%3Dy/reset-revocation":
        payload,
    });

    await expect(
      client.resetBrowserBridgeCompanionRevocation("companion rev &x=y"),
    ).resolves.toEqual(payload);

    const last = request.mock.calls.at(-1);
    if (!last) throw new Error("no transport call recorded");
    const [url, init] = last;
    expect(url).toBe(
      "http://agent.example:31337/api/browser-bridge/companions/companion%20rev%20%26x%3Dy/reset-revocation",
    );
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
  });
});
