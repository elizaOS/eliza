/**
 * LifeOps Google OAuth start must use the canonical GOOGLE_REDIRECT_URI instead
 * of deriving a portless callback from INTERNAL_URL, must fail closed before
 * redirecting to Google when the callback cannot reach the served origin, and
 * must never report a persisted grant as disconnected because of a callback
 * config mistake. Deterministic: manager and repository are stubbed.
 */
import { describe, expect, it, vi } from "vitest";
import { GoogleDomain } from "./google-service.js";

const CANONICAL = "http://127.0.0.1:31437/api/connectors/google/oauth/callback";

function connectedAccount() {
  const now = Date.now();
  return {
    id: "acct-1",
    provider: "google",
    role: "OWNER",
    purpose: ["messaging"],
    accessGate: "open",
    status: "connected",
    externalId: "sub-1",
    displayHandle: "owner@example.com",
    createdAt: now,
    updatedAt: now,
    metadata: {
      email: "owner@example.com",
      grantedCapabilities: ["gmail.triage"],
      grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      hasRefreshToken: true,
    },
  };
}

function fakeManager(accounts: unknown[]) {
  return {
    registerProvider: () => undefined,
    evaluatePolicy: () => undefined,
    getProvider: () => ({ provider: "google" }),
    listAccounts: async () => accounts,
  };
}

function domainWith(accounts: unknown[], settings: Record<string, string>) {
  const manager = fakeManager(accounts);
  const runtime = {
    getSetting: (key: string) => settings[key],
    getService: () => manager,
  };
  const ctx = { runtime, agentId: () => "agent-1" };
  return new GoogleDomain(ctx as never);
}

describe("GoogleDomain OAuth callback parity", () => {
  it("starts OAuth with GOOGLE_REDIRECT_URI, not a portless INTERNAL_URL origin", async () => {
    const startOAuth = vi.fn(async () => ({
      redirectUri: CANONICAL,
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test",
    }));
    const runtime = {
      getSetting: (key: string) =>
        ({
          GOOGLE_CLIENT_ID: "client-id",
          GOOGLE_CLIENT_SECRET: "client-secret",
          GOOGLE_REDIRECT_URI: CANONICAL,
        })[key],
    };
    const manager = {
      getProvider: () => ({ provider: "google" }),
      startOAuth,
    };
    const ctx = {
      runtime,
      agentId: () => "agent-1",
      repository: {
        listCalendarEvents: vi.fn(async () => []),
        deleteCalendarEventsForProvider: vi.fn(async () => undefined),
        deleteCalendarSyncState: vi.fn(async () => undefined),
        deleteGmailSyncState: vi.fn(async () => undefined),
        deleteGmailMessagesForProvider: vi.fn(async () => undefined),
      },
    };
    const domain = new GoogleDomain(ctx as never);
    vi.spyOn(domain as never, "googleConnectorManager").mockReturnValue(
      manager as never,
    );

    const response = await domain.startGoogleConnector(
      { side: "owner" },
      new URL("http://127.0.0.1/"),
    );

    expect(startOAuth).toHaveBeenCalledWith(
      "google",
      expect.not.objectContaining({ redirectUri: expect.anything() }),
    );
    expect(response.redirectUri).toBe(CANONICAL);
  });

  it("fails OAuth start closed when the callback cannot reach the served origin", async () => {
    const domain = domainWith([], {
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
      GOOGLE_REDIRECT_URI: CANONICAL,
    });
    await expect(
      domain.startGoogleConnector(
        { side: "owner" },
        new URL("http://127.0.0.1:2138/api/lifeops/connectors/google/start"),
      ),
    ).rejects.toThrow(/served on port 2138/);
  });

  it("fails OAuth start closed on a credential/query/fragment-bearing callback", async () => {
    for (const redirect of [
      "http://user:pass@127.0.0.1:31437/api/connectors/google/oauth/callback",
      `${CANONICAL}?next=https://evil.example`,
      `${CANONICAL}#frag`,
    ]) {
      const domain = domainWith([], {
        GOOGLE_CLIENT_ID: "client-id",
        GOOGLE_CLIENT_SECRET: "client-secret",
        GOOGLE_REDIRECT_URI: redirect,
      });
      await expect(
        domain.startGoogleConnector(
          { side: "owner" },
          new URL("http://127.0.0.1:31437/api/lifeops/connectors/google/start"),
        ),
      ).rejects.toThrow(/callback is not usable/);
    }
  });

  it("keeps a persisted grant connected when the callback config is broken", async () => {
    const domain = domainWith([connectedAccount()], {
      // Portless loopback: the misconfiguration Shaw's leftover names.
      GOOGLE_REDIRECT_URI:
        "http://127.0.0.1/api/connectors/google/oauth/callback",
    });
    const status = await domain.getGoogleConnectorStatus(
      new URL("http://127.0.0.1:2138/api/lifeops/connectors/google"),
      "local",
      "owner",
    );
    expect(status.connected).toBe(true);
    expect(status.configured).toBe(true);
    expect(status.reason).toBe("connected");
    expect(status.grant).not.toBeNull();
  });

  it("reports callback misconfiguration only when no account is persisted", async () => {
    const domain = domainWith([], {
      GOOGLE_REDIRECT_URI:
        "http://127.0.0.1/api/connectors/google/oauth/callback",
    });
    const status = await domain.getGoogleConnectorStatus(
      new URL("http://127.0.0.1:2138/api/lifeops/connectors/google"),
      "local",
      "owner",
    );
    expect(status.connected).toBe(false);
    expect(status.configured).toBe(false);
    expect(status.reason).toBe("config_missing");
    expect(
      status.degradations?.some(
        (degradation) =>
          degradation.code === "google_oauth_callback_portless_loopback",
      ),
    ).toBe(true);
  });

  it("reports a served-origin port mismatch in the disconnected status", async () => {
    const domain = domainWith([], { GOOGLE_REDIRECT_URI: CANONICAL });
    const status = await domain.getGoogleConnectorStatus(
      new URL("http://127.0.0.1:2138/api/lifeops/connectors/google"),
      "local",
      "owner",
    );
    expect(status.configured).toBe(false);
    expect(
      status.degradations?.some(
        (degradation) =>
          degradation.code === "google_oauth_callback_wrong_port",
      ),
    ).toBe(true);
  });
});
