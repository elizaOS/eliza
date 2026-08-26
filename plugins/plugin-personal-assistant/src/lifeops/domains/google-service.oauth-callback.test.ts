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

/** Domain wired for OAuth start: a manager whose startOAuth echoes the callback. */
function startDomainWith(
  redirectUri: string,
  settings: Record<string, string> = {},
) {
  const startOAuth = vi.fn(async () => ({
    redirectUri,
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test",
  }));
  const runtime = {
    getSetting: (key: string) =>
      ({
        GOOGLE_CLIENT_ID: "client-id",
        GOOGLE_CLIENT_SECRET: "client-secret",
        GOOGLE_REDIRECT_URI: redirectUri,
        ...settings,
      })[key],
  };
  const domain = new GoogleDomain({
    runtime,
    agentId: () => "agent-1",
  } as never);
  vi.spyOn(domain as never, "googleConnectorManager").mockReturnValue({
    getProvider: () => ({ provider: "google" }),
    startOAuth,
  } as never);
  return { domain, startOAuth };
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
          ELIZA_API_PORT: "31437",
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

  it("starts OAuth from chat (INTERNAL_URL sentinel) against a production callback", async () => {
    // Shaw's production probe: chat has no HTTP request, so the synthetic
    // INTERNAL_URL must not masquerade as the served origin and reject a
    // valid https callback as wrong_host.
    const production =
      "https://eliza.example/api/connectors/google/oauth/callback";
    const { domain, startOAuth } = startDomainWith(production);
    const response = await domain.startGoogleConnector(
      { side: "owner" },
      new URL("http://127.0.0.1/"),
    );
    expect(response.redirectUri).toBe(production);
    expect(response.authUrl).not.toBe("");
    expect(startOAuth).toHaveBeenCalledWith(
      "google",
      expect.objectContaining({ servedOrigin: undefined }),
    );
  });

  it("starts OAuth from chat against a local loopback callback", async () => {
    const { domain, startOAuth } = startDomainWith(CANONICAL, {
      ELIZA_API_PORT: "31437",
    });
    const response = await domain.startGoogleConnector(
      { side: "owner" },
      new URL("http://127.0.0.1/"),
    );
    expect(response.redirectUri).toBe(CANONICAL);
    expect(startOAuth).toHaveBeenCalledWith(
      "google",
      expect.objectContaining({ servedOrigin: "http://127.0.0.1:31437" }),
    );
  });

  it("fails chat OAuth start when the configured loopback callback misses the API port", async () => {
    const { domain } = startDomainWith(CANONICAL, {
      ELIZA_API_PORT: "2138",
    });
    await expect(
      domain.startGoogleConnector(
        { side: "owner" },
        new URL("http://127.0.0.1/"),
      ),
    ).rejects.toThrow(/served on port 2138/);
  });

  it("uses the configured concrete API bind host for chat reachability", async () => {
    const { domain } = startDomainWith(CANONICAL, {
      ELIZA_API_BIND: "localhost",
      ELIZA_API_PORT: "31437",
    });
    await expect(
      domain.startGoogleConnector(
        { side: "owner" },
        new URL("http://127.0.0.1/"),
      ),
    ).rejects.toThrow(/served on localhost/);
  });

  it("accepts a loopback callback proven reachable through a wildcard bind", async () => {
    const { domain, startOAuth } = startDomainWith(CANONICAL, {
      ELIZA_API_BIND: "0.0.0.0",
      ELIZA_API_PORT: "31437",
    });
    await domain.startGoogleConnector(
      { side: "owner" },
      new URL("http://127.0.0.1/"),
    );
    expect(startOAuth).toHaveBeenCalledWith(
      "google",
      expect.objectContaining({ servedOrigin: "http://127.0.0.1:31437" }),
    );
  });

  it("forwards the real served origin to the connector start boundary", async () => {
    const staging =
      "https://staging.eliza.example/api/connectors/google/oauth/callback";
    const { domain, startOAuth } = startDomainWith(staging);
    const requestUrl = new URL(
      "https://staging.eliza.example/api/lifeops/connectors/google/start",
    );
    await domain.startGoogleConnector({ side: "owner" }, requestUrl);
    expect(startOAuth).toHaveBeenCalledWith(
      "google",
      expect.objectContaining({ servedOrigin: requestUrl.origin }),
    );
  });

  it("uses the configured external origin for chat OAuth callback validation", async () => {
    const callback =
      "https://eliza.example/api/connectors/google/oauth/callback";
    const { domain, startOAuth } = startDomainWith(callback, {
      ELIZA_EXTERNAL_BASE_URL: "https://eliza.example/app",
    });
    await domain.startGoogleConnector(
      { side: "owner" },
      new URL("http://127.0.0.1/"),
    );
    expect(startOAuth).toHaveBeenCalledWith(
      "google",
      expect.objectContaining({
        servedOrigin: "https://eliza.example",
      }),
    );
  });

  it("rejects a configured external origin that does not match the callback", async () => {
    const callback =
      "https://eliza.example/api/connectors/google/oauth/callback";
    const { domain } = startDomainWith(callback, {
      ELIZA_EXTERNAL_BASE_URL: "https://other.example",
    });
    await expect(
      domain.startGoogleConnector(
        { side: "owner" },
        new URL("http://127.0.0.1/"),
      ),
    ).rejects.toThrow(/served on other\.example/);
  });

  it("rejects a malformed external origin without echoing its secret", async () => {
    const secret = "external-origin-secret";
    const callback =
      "https://eliza.example/api/connectors/google/oauth/callback";
    const { domain } = startDomainWith(callback, {
      ELIZA_EXTERNAL_BASE_URL: `not a URL ${secret}`,
    });
    await expect(
      domain.startGoogleConnector(
        { side: "owner" },
        new URL("http://127.0.0.1/"),
      ),
    ).rejects.toThrow(
      "Google OAuth callback is not usable: The configured external connector origin is not a valid URL.",
    );
  });

  it("still fails closed when a real served origin does not match the callback", async () => {
    const { domain } = startDomainWith(
      "https://eliza.example/api/connectors/google/oauth/callback",
    );
    await expect(
      domain.startGoogleConnector(
        { side: "owner" },
        new URL("https://other.example/api/lifeops/connectors/google/start"),
      ),
    ).rejects.toThrow(/callback is not usable/);
  });

  it("keeps callback diagnostics for an errored account that needs a new flow", async () => {
    // Shaw's readiness probe: an errored persisted account plus a broken
    // portless callback must report needs_reauth AND the callback degradation,
    // so the operator can fix the callback before retrying reauth.
    const domain = domainWith([{ ...connectedAccount(), status: "error" }], {
      GOOGLE_REDIRECT_URI:
        "http://127.0.0.1/api/connectors/google/oauth/callback",
    });
    const status = await domain.getGoogleConnectorStatus(
      new URL("http://127.0.0.1:2138/api/lifeops/connectors/google"),
      "local",
      "owner",
    );
    expect(status.connected).toBe(false);
    expect(status.reason).toBe("needs_reauth");
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

  it("disconnects credentials without silently deleting imported projections", async () => {
    let accounts = [connectedAccount()];
    const deleteAccount = vi.fn(async () => {
      accounts = [];
    });
    const manager = {
      registerProvider: () => undefined,
      evaluatePolicy: () => undefined,
      getProvider: () => ({ provider: "google" }),
      listAccounts: async () => accounts,
      deleteAccount,
    };
    const repository = {
      listCalendarEvents: vi.fn(async () => []),
      deleteCalendarEventsForProvider: vi.fn(async () => undefined),
      deleteCalendarSyncState: vi.fn(async () => undefined),
      deleteGmailSyncState: vi.fn(async () => undefined),
      deleteGmailMessagesForProvider: vi.fn(async () => undefined),
    };
    const domain = new GoogleDomain({
      runtime: {
        getSetting: () => undefined,
        getService: () => manager,
      },
      agentId: () => "agent-1",
      repository,
      recordConnectorAudit: vi.fn(async () => undefined),
    } as never);

    const status = await domain.disconnectGoogleConnector(
      {
        side: "owner",
        mode: "local",
        grantId: "connector-account:acct-1",
      },
      new URL("http://127.0.0.1/"),
    );

    expect(deleteAccount).toHaveBeenCalledWith("google", "acct-1");
    expect(status.connected).toBe(false);
    expect(repository.deleteCalendarEventsForProvider).not.toHaveBeenCalled();
    expect(repository.deleteCalendarSyncState).not.toHaveBeenCalled();
    expect(repository.deleteGmailSyncState).not.toHaveBeenCalled();
    expect(repository.deleteGmailMessagesForProvider).not.toHaveBeenCalled();
  });

  it("purges the imported projection only when the disconnect asks for it", async () => {
    let accounts = [connectedAccount()];
    const manager = {
      registerProvider: () => undefined,
      evaluatePolicy: () => undefined,
      getProvider: () => ({ provider: "google" }),
      listAccounts: async () => accounts,
      deleteAccount: vi.fn(async () => {
        accounts = [];
      }),
    };
    const repository = {
      listCalendarEvents: vi.fn(async () => []),
      deleteCalendarEventsForProvider: vi.fn(async () => undefined),
      deleteCalendarSyncState: vi.fn(async () => undefined),
      deleteGmailSyncState: vi.fn(async () => undefined),
      deleteGmailMessagesForProvider: vi.fn(async () => undefined),
      deleteGmailSpamReviewItemsForProvider: vi.fn(async () => undefined),
    };
    const domain = new GoogleDomain({
      runtime: {
        getSetting: () => undefined,
        getService: () => manager,
      },
      agentId: () => "agent-1",
      repository,
      recordConnectorAudit: vi.fn(async () => undefined),
    } as never);

    const status = await domain.disconnectGoogleConnector(
      {
        side: "owner",
        mode: "local",
        grantId: "connector-account:acct-1",
        purgeImportedData: true,
      },
      new URL("http://127.0.0.1/"),
    );

    expect(status.connected).toBe(false);
    expect(repository.deleteGmailMessagesForProvider).toHaveBeenCalledWith(
      "agent-1",
      "google",
      "owner",
      "connector-account:acct-1",
    );
    expect(repository.deleteCalendarEventsForProvider).toHaveBeenCalled();
  });
});
