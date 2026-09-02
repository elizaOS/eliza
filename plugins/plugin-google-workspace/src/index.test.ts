/**
 * Unit coverage for the plugin surface: the service facade, credential resolver,
 * connector account provider OAuth flow, and each sub-client's DTO mapping.
 * Deterministic harness — googleapis clients and the OAuth token/userinfo fetch
 * are stubbed via fake client factories and a stubbed `fetch`; no live Google
 * API is contacted.
 */
import type {
  ConnectorAccount,
  ConnectorAccountPatch,
  ConnectorAccountStorage,
  IAgentRuntime,
} from "@elizaos/core";
import { getConnectorAccountManager } from "@elizaos/core";
import { getConnectorAccountCatalogEntry } from "@elizaos/shared/connector-account-catalog";
import { Auth } from "googleapis";

const { OAuth2Client } = Auth;
const TEST_OIDC_NONCE = "test-oidc-nonce";

import { afterEach, describe, expect, it, vi } from "vitest";
import googlePlugin, {
  createGoogleConnectorAccountProvider,
  DefaultGoogleCredentialResolver,
  GOOGLE_CAPABILITIES,
  GOOGLE_MEET_API_SURFACE,
  GOOGLE_OAUTH_SCOPES,
  type GoogleApiClientFactory,
  GoogleCalendarClient,
  GoogleDriveClient,
  GoogleGmailClient,
  GoogleMeetClient,
  GoogleMeetStatus,
  GoogleWorkspaceService,
  getGoogleOAuthProviderConfig,
  normalizeGoogleCapabilities,
  scopesForGoogleCapabilities,
} from "./index.js";

function expectIncrementalGrantingDisabled(url: URL): void {
  expect(url.searchParams.get("include_granted_scopes")).toBe("false");
}

describe("google plugin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("registers the Google connector account provider on init", async () => {
    const runtime = {
      getService: vi.fn(() => null),
      getSetting: vi.fn(() => undefined),
    } as IAgentRuntime;

    await googlePlugin.init?.({}, runtime);

    expect(getConnectorAccountManager(runtime).getProvider("google")).toEqual(
      expect.objectContaining({
        provider: "google",
        startOAuth: expect.any(Function),
        completeOAuth: expect.any(Function),
      })
    );
  });

  it("declares google-chat as a passive connector source", () => {
    // Core's agent-event-bridge only mints user notifications for sources the
    // registry classifies as passive; without this declaration Google Chat
    // ingress would fail closed and silently stop notifying.
    expect(googlePlugin.connectorSources).toEqual([
      expect.objectContaining({
        source: "google-chat",
        sourceKind: "passive",
        isPassive: true,
      }),
    ]);
  });

  it("derives OAuth scopes only from selected capabilities", () => {
    const scopes = scopesForGoogleCapabilities(["gmail.read", "calendar.write", "meet.create"]);

    expect(scopes).toEqual([
      GOOGLE_OAUTH_SCOPES.profile.openid,
      GOOGLE_OAUTH_SCOPES.profile.email,
      GOOGLE_OAUTH_SCOPES.profile.profile,
      GOOGLE_OAUTH_SCOPES.gmail.read,
      GOOGLE_OAUTH_SCOPES.calendar.write,
      GOOGLE_OAUTH_SCOPES.meet.create,
    ]);
    expect(scopes).not.toContain(GOOGLE_OAUTH_SCOPES.drive.write);
    expect(scopes).not.toContain(GOOGLE_OAUTH_SCOPES.meet.read);
  });

  it("keeps provider capabilities aligned with the shared connector declaration", () => {
    expect(
      getConnectorAccountCatalogEntry("google")?.oauthCapabilities?.map(
        (capability) => capability.id
      )
    ).toEqual(GOOGLE_CAPABILITIES);
  });

  it("normalizes capability input and preserves opt-in OAuth metadata without incremental grants", () => {
    const config = getGoogleOAuthProviderConfig(
      normalizeGoogleCapabilities(["drive.read", "drive.read", "meet.read", "unknown"])
    );

    expect(config.provider).toBe("google");
    expect(config.capabilities).toEqual(["drive.read", "meet.read"]);
    expect(config.scopes).toContain(GOOGLE_OAUTH_SCOPES.drive.read);
    expect(config.scopes).toContain(GOOGLE_OAUTH_SCOPES.meet.read);
    expect(config.scopes).not.toContain(GOOGLE_OAUTH_SCOPES.gmail.send);
    expect(config.authorizationParams.include_granted_scopes).toBe("false");
  });

  it("rejects unknown connector OAuth capabilities instead of widening access", async () => {
    const runtime = {
      getSetting: (key: string) =>
        ({
          GOOGLE_CLIENT_ID: "google-client",
          GOOGLE_CLIENT_SECRET: "google-secret",
          GOOGLE_REDIRECT_URI: "http://localhost:31437/api/connectors/google/oauth/callback",
        })[key],
      getService: () => null,
    } as never;
    const provider = createGoogleConnectorAccountProvider(runtime);

    await expect(
      provider.startOAuth?.(
        {
          provider: "google",
          scopes: ["google.calendar.read"],
          metadata: { requestedRole: "OWNER" },
          flow: {
            id: "flow-invalid-capability",
            provider: "google",
            state: "state-invalid-capability",
            status: "pending",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
        {} as never
      )
    ).rejects.toThrow("Google OAuth capability or scope is not recognized: google.calendar.read");
  });

  it("rejects identity-only connector OAuth requests with no usable capability", async () => {
    const runtime = {
      getSetting: (key: string) =>
        ({
          GOOGLE_CLIENT_ID: "google-client",
          GOOGLE_CLIENT_SECRET: "google-secret",
          GOOGLE_REDIRECT_URI: "http://localhost:31437/api/connectors/google/oauth/callback",
        })[key],
      getService: () => null,
    } as never;
    const provider = createGoogleConnectorAccountProvider(runtime);

    await expect(
      provider.startOAuth?.(
        {
          provider: "google",
          scopes: [
            GOOGLE_OAUTH_SCOPES.profile.openid,
            GOOGLE_OAUTH_SCOPES.profile.email,
            GOOGLE_OAUTH_SCOPES.profile.profile,
          ],
          metadata: { requestedRole: "OWNER" },
          flow: {
            id: "flow-identity-only",
            provider: "google",
            state: "state-identity-only",
            status: "pending",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
        {} as never
      )
    ).rejects.toThrow(
      "Google OAuth requires at least one Gmail, Calendar, Drive, or Meet capability."
    );
  });

  it.each([
    {
      label: "omitted scopes",
      scopes: undefined,
    },
    {
      label: "empty scopes",
      scopes: [],
    },
  ])("fails closed when OAuth start receives $label", async ({ scopes }) => {
    const runtime = {
      getSetting: (key: string) =>
        ({
          GOOGLE_CLIENT_ID: "google-client",
          GOOGLE_CLIENT_SECRET: "google-secret",
          GOOGLE_REDIRECT_URI: "http://localhost:31437/api/connectors/google/oauth/callback",
        })[key],
      getService: () => null,
    } as never;
    const provider = createGoogleConnectorAccountProvider(runtime);

    await expect(
      provider.startOAuth?.(
        {
          provider: "google",
          scopes,
          metadata: { requestedRole: "OWNER" },
          flow: {
            id: "flow-missing-capabilities",
            provider: "google",
            state: "state-missing-capabilities",
            status: "pending",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
        {} as never
      )
    ).rejects.toThrow(
      "Google OAuth requires an explicit Gmail, Calendar, Drive, or Meet capability selection."
    );
  });

  it("defaults re-auth with accountId and omitted scopes to the account's recorded granted capabilities (#18543)", async () => {
    const runtime = {
      getSetting: (key: string) =>
        ({
          GOOGLE_CLIENT_ID: "google-client",
          GOOGLE_CLIENT_SECRET: "google-secret",
          GOOGLE_REDIRECT_URI: "http://localhost:31437/api/connectors/google/oauth/callback",
        })[key],
      getService: () => null,
    } as never;
    const provider = createGoogleConnectorAccountProvider(runtime);
    const getAccount = vi.fn(async (_provider: string, accountId: string) => ({
      id: accountId,
      provider: "google",
      role: "OWNER",
      metadata: { grantedCapabilities: ["gmail.read", "calendar.read"] },
    }));

    const result = await provider.startOAuth?.(
      {
        provider: "google",
        accountId: "acct-reauth-1",
        flow: {
          id: "flow-reauth",
          provider: "google",
          state: "state-reauth",
          status: "pending",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
      { getAccount } as never
    );

    expect(getAccount).toHaveBeenCalledWith("google", "acct-reauth-1");
    const url = new URL(result?.authUrl ?? "");
    expectIncrementalGrantingDisabled(url);
    const requestedScopes = new Set(
      (url.searchParams.get("scope") ?? "").split(" ").filter(Boolean)
    );
    // Least privilege: exactly the recorded grant, never an expansion.
    expect(requestedScopes).toEqual(
      new Set([
        GOOGLE_OAUTH_SCOPES.profile.openid,
        GOOGLE_OAUTH_SCOPES.profile.email,
        GOOGLE_OAUTH_SCOPES.profile.profile,
        GOOGLE_OAUTH_SCOPES.gmail.read,
        GOOGLE_OAUTH_SCOPES.calendar.read,
      ])
    );
    expect(requestedScopes).not.toContain(GOOGLE_OAUTH_SCOPES.drive.read);
    expect(result?.metadata).toMatchObject({
      requestedCapabilities: ["gmail.read", "calendar.read"],
    });
    // The provider-owned callback must be returned at the top level so the
    // manager persists it (result.redirectUri ?? flow.redirectUri).
    expect(result?.redirectUri).toBe("http://localhost:31437/api/connectors/google/oauth/callback");
  });

  it("keeps failing closed when the re-auth accountId is unknown", async () => {
    const runtime = {
      getSetting: (key: string) =>
        ({
          GOOGLE_CLIENT_ID: "google-client",
          GOOGLE_CLIENT_SECRET: "google-secret",
          GOOGLE_REDIRECT_URI: "http://localhost:31437/api/connectors/google/oauth/callback",
        })[key],
      getService: () => null,
    } as never;
    const provider = createGoogleConnectorAccountProvider(runtime);

    await expect(
      provider.startOAuth?.(
        {
          provider: "google",
          accountId: "acct-missing",
          flow: {
            id: "flow-reauth-missing",
            provider: "google",
            state: "state-reauth-missing",
            status: "pending",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
        { getAccount: vi.fn(async () => null) } as never
      )
    ).rejects.toThrow("Google OAuth cannot reauthorize a connector account that no longer exists.");
  });

  it("keeps failing closed when the account has no recorded granted capabilities", async () => {
    const runtime = {
      getSetting: (key: string) =>
        ({
          GOOGLE_CLIENT_ID: "google-client",
          GOOGLE_CLIENT_SECRET: "google-secret",
          GOOGLE_REDIRECT_URI: "http://localhost:31437/api/connectors/google/oauth/callback",
        })[key],
      getService: () => null,
    } as never;
    const provider = createGoogleConnectorAccountProvider(runtime);

    await expect(
      provider.startOAuth?.(
        {
          provider: "google",
          accountId: "acct-no-grant",
          flow: {
            id: "flow-reauth-nogrant",
            provider: "google",
            state: "state-reauth-nogrant",
            status: "pending",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
        {
          getAccount: vi.fn(async () => ({
            id: "acct-no-grant",
            provider: "google",
            role: "OWNER",
            metadata: {},
          })),
        } as never
      )
    ).rejects.toThrow(
      "Google OAuth requires an explicit Gmail, Calendar, Drive, or Meet capability selection."
    );
  });

  it("lets explicit scopes win while retaining the stored reauthorization role", async () => {
    const runtime = {
      getSetting: (key: string) =>
        ({
          GOOGLE_CLIENT_ID: "google-client",
          GOOGLE_CLIENT_SECRET: "google-secret",
          GOOGLE_REDIRECT_URI: "http://localhost:31437/api/connectors/google/oauth/callback",
        })[key],
      getService: () => null,
    } as never;
    const provider = createGoogleConnectorAccountProvider(runtime);
    const getAccount = vi.fn(async () => ({
      id: "acct-reauth-2",
      provider: "google",
      role: "TEAM",
      metadata: {
        grantedCapabilities: ["gmail.read", "gmail.send", "calendar.read", "drive.read"],
      },
    }));

    const result = await provider.startOAuth?.(
      {
        provider: "google",
        accountId: "acct-reauth-2",
        scopes: ["gmail.read"],
        flow: {
          id: "flow-reauth-narrow",
          provider: "google",
          state: "state-reauth-narrow",
          status: "pending",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
      { getAccount } as never
    );

    expect(getAccount).toHaveBeenCalledWith("google", "acct-reauth-2");
    expect(result?.metadata).toMatchObject({ requestedRole: "TEAM" });
    const url = new URL(result?.authUrl ?? "");
    expectIncrementalGrantingDisabled(url);
    const requestedScopes = new Set(
      (url.searchParams.get("scope") ?? "").split(" ").filter(Boolean)
    );
    expect(requestedScopes).toContain(GOOGLE_OAUTH_SCOPES.gmail.read);
    expect(requestedScopes).not.toContain(GOOGLE_OAUTH_SCOPES.gmail.send);
    expect(requestedScopes).not.toContain(GOOGLE_OAUTH_SCOPES.drive.read);
  });

  it("derives a least-privilege connector OAuth URL from gmail.read and calendar.read", async () => {
    const runtime = {
      getSetting: (key: string) =>
        ({
          GOOGLE_CLIENT_ID: "google-client",
          GOOGLE_CLIENT_SECRET: "google-secret",
          GOOGLE_REDIRECT_URI: "http://localhost:31437/api/connectors/google/oauth/callback",
        })[key],
      getService: () => null,
    } as never;
    const provider = createGoogleConnectorAccountProvider(runtime);

    const result = await provider.startOAuth?.(
      {
        provider: "google",
        scopes: ["gmail.read", "calendar.read"],
        metadata: { requestedRole: "OWNER" },
        flow: {
          id: "flow-gmail-calendar-read",
          provider: "google",
          state: "state-gmail-calendar-read",
          status: "pending",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
      {} as never
    );
    const url = new URL(result?.authUrl ?? "");
    expectIncrementalGrantingDisabled(url);
    const requestedScopes = new Set(
      (url.searchParams.get("scope") ?? "").split(" ").filter(Boolean)
    );

    expect(requestedScopes).toEqual(
      new Set([
        GOOGLE_OAUTH_SCOPES.profile.openid,
        GOOGLE_OAUTH_SCOPES.profile.email,
        GOOGLE_OAUTH_SCOPES.profile.profile,
        GOOGLE_OAUTH_SCOPES.gmail.read,
        GOOGLE_OAUTH_SCOPES.calendar.read,
      ])
    );
    expect(requestedScopes).not.toContain(GOOGLE_OAUTH_SCOPES.drive.read);
    expect(requestedScopes).not.toContain(GOOGLE_OAUTH_SCOPES.drive.write);
    expect(requestedScopes).not.toContain(GOOGLE_OAUTH_SCOPES.meet.create);
    expect(requestedScopes).not.toContain(GOOGLE_OAUTH_SCOPES.meet.read);
    expect(result?.metadata).toMatchObject({
      requestedCapabilities: ["gmail.read", "calendar.read"],
    });
  });

  it("derives a least-privilege connector OAuth URL from calendar.read", async () => {
    const runtime = {
      getSetting: (key: string) =>
        ({
          GOOGLE_CLIENT_ID: "google-client",
          GOOGLE_CLIENT_SECRET: "google-secret",
          GOOGLE_REDIRECT_URI: "http://localhost:31437/api/connectors/google/oauth/callback",
        })[key],
      getService: () => null,
    } as never;
    const provider = createGoogleConnectorAccountProvider(runtime);

    const result = await provider.startOAuth?.(
      {
        provider: "google",
        scopes: ["calendar.read"],
        metadata: { requestedRole: "OWNER" },
        flow: {
          id: "flow-calendar-read",
          provider: "google",
          state: "state-calendar-read",
          status: "pending",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
      {} as never
    );
    const url = new URL(result?.authUrl ?? "");
    expectIncrementalGrantingDisabled(url);
    const requestedScopes = new Set(
      (url.searchParams.get("scope") ?? "").split(" ").filter(Boolean)
    );

    expect(requestedScopes).toEqual(
      new Set([
        GOOGLE_OAUTH_SCOPES.profile.openid,
        GOOGLE_OAUTH_SCOPES.profile.email,
        GOOGLE_OAUTH_SCOPES.profile.profile,
        GOOGLE_OAUTH_SCOPES.calendar.read,
      ])
    );
    expect(requestedScopes).not.toContain(GOOGLE_OAUTH_SCOPES.calendar.write);
    expect(result?.metadata).toMatchObject({
      requestedCapabilities: ["calendar.read"],
    });
  });

  it("keeps account auth resolution explicit", async () => {
    const service = new GoogleWorkspaceService();
    const metadata = service.getOAuthProviderMetadata();

    expect(metadata.provider).toBe("google");
    expect(metadata.capabilities).toContain("meet.read");
    await expect(
      service.searchMessages({ accountId: "acct_google_1", query: "from:example" })
    ).rejects.toThrow("account acct_google_1");
  });

  it("has a clean account-scoped Meet surface", () => {
    const service = new GoogleWorkspaceService();
    const methods = GOOGLE_MEET_API_SURFACE.map((entry) => entry.method);

    expect(methods).toEqual([
      "createMeeting",
      "getMeeting",
      "getMeetingSpace",
      "getConferenceRecord",
      "listMeetingParticipants",
      "listMeetingParticipantSessions",
      "listMeetingTranscripts",
      "getMeetingTranscript",
      "listMeetingRecordings",
      "getMeetingRecordingUrl",
      "endMeeting",
      "generateReport",
    ]);
    for (const method of methods) {
      expect(typeof service[method]).toBe("function");
    }
    expect("authenticateInteractive" in service).toBe(false);
    expect("getCurrentMeeting" in service).toBe(false);
    expect(GoogleMeetStatus.WAITING).toBe("waiting");
  });

  it("resolves OAuth clients from connector credential refs and caches by credential version", async () => {
    const credentialUpdatedAt = new Date("2026-05-07T12:00:00.000Z").toISOString();
    const storage = createCredentialStorage({
      records: [
        {
          credentialType: "oauth.access_token",
          vaultRef: "connector.agent.google.acct_google_1.access",
          updatedAt: credentialUpdatedAt,
          expiresAt: Date.now() + 3600_000,
        },
        {
          credentialType: "oauth.refresh_token",
          vaultRef: "connector.agent.google.acct_google_1.refresh",
          updatedAt: credentialUpdatedAt,
        },
      ],
    });
    const credentialStore = {
      get: vi.fn(async (vaultRef: string) => {
        if (vaultRef.endsWith(".access")) return "access-token";
        if (vaultRef.endsWith(".refresh")) return "refresh-token";
        return null;
      }),
    };
    const resolver = new DefaultGoogleCredentialResolver({
      storage,
      credentialStore,
      clientId: "google-client",
      clientSecret: "google-secret",
      redirectUri: "http://localhost:31437/api/connectors/google/oauth/callback",
    });

    const request = {
      provider: "google" as const,
      accountId: "acct_google_1",
      capabilities: ["gmail.read"] as const,
      scopes: scopesForGoogleCapabilities(["gmail.read"]),
      reason: "unit-test",
    };

    const first = await resolver.getAuthClient(request);
    const second = await resolver.getAuthClient(request);

    expect(first).toBeInstanceOf(OAuth2Client);
    expect(first).toBe(second);
    expect(first.credentials).toMatchObject({
      access_token: "access-token",
      refresh_token: "refresh-token",
      scope: request.scopes.join(" "),
    });
    expect(credentialStore.get).toHaveBeenCalledTimes(2);
  });

  it("resolves OAuth clients from account metadata credential refs", async () => {
    const storage = createCredentialStorage({
      records: [],
      metadata: {
        credentialRefs: [
          {
            credentialType: "oauth.tokens",
            vaultRef: "connector.agent.google.acct_google_1.oauth_tokens",
          },
        ],
        oauthCredentialVersion: "v1",
      },
    });
    const credentialStore = {
      get: vi.fn(async () =>
        JSON.stringify({
          access_token: "metadata-ref-access",
          refresh_token: "metadata-ref-refresh",
          expiry_date: Date.now() + 3600_000,
        })
      ),
    };
    const resolver = new DefaultGoogleCredentialResolver({
      storage,
      credentialStore,
      clientId: "google-client",
      clientSecret: "google-secret",
    });

    const client = await resolver.getAuthClient({
      provider: "google",
      accountId: "acct_google_1",
      capabilities: ["gmail.read"],
      scopes: scopesForGoogleCapabilities(["gmail.read"]),
      reason: "unit-test",
    });

    expect(client.credentials).toMatchObject({
      access_token: "metadata-ref-access",
      refresh_token: "metadata-ref-refresh",
    });
    expect(credentialStore.get).toHaveBeenCalledWith(
      "connector.agent.google.acct_google_1.oauth_tokens",
      expect.objectContaining({ reveal: true })
    );
  });

  it("preserves nested token precedence and scopes through the resolver boundary", async () => {
    const storage = createCredentialStorage({
      records: [
        {
          credentialType: "oauth.tokens",
          value: JSON.stringify({
            tokens: {
              access_token: "nested-access",
              refresh_token: "nested-refresh",
              scope: "nested.scope",
            },
            accessToken: "outer-access",
            scopes: ["gmail.read", "drive.readonly"],
          }),
        },
      ],
    });
    const resolver = new DefaultGoogleCredentialResolver({
      storage,
      clientId: "google-client",
      clientSecret: "google-secret",
    });

    const client = await resolver.getAuthClient({
      provider: "google",
      accountId: "acct_google_1",
      capabilities: ["gmail.read"],
      scopes: scopesForGoogleCapabilities(["gmail.read"]),
      reason: "unit-test",
    });

    expect(client.credentials).toMatchObject({
      access_token: "outer-access",
      refresh_token: "nested-refresh",
      scope: "gmail.read drive.readonly",
    });
  });

  it("does not keep unsafe OAuth client cache entries when no credential version is exposed", async () => {
    const storage = createCredentialStorage({
      records: [
        {
          credentialType: "oauth.tokens",
          value: JSON.stringify({
            access_token: "access-token",
            refresh_token: "refresh-token",
            expiry_date: Date.now() + 3600_000,
          }),
        },
      ],
    });
    const resolver = new DefaultGoogleCredentialResolver({
      storage,
      clientId: "google-client",
      clientSecret: "google-secret",
    });
    const request = {
      provider: "google" as const,
      accountId: "acct_google_1",
      capabilities: ["calendar.read"] as const,
      scopes: scopesForGoogleCapabilities(["calendar.read"]),
      reason: "unit-test",
    };

    const first = await resolver.getAuthClient(request);
    const second = await resolver.getAuthClient(request);

    expect(first).not.toBe(second);
    expect(first.credentials.refresh_token).toBe("refresh-token");
  });

  it("does not resolve OAuth clients from token-shaped account metadata", async () => {
    const storage = createCredentialStorage({
      records: [],
      metadata: {
        oauthTokens: {
          access_token: "metadata-access-token",
          refresh_token: "metadata-refresh-token",
        },
      },
    });
    const resolver = new DefaultGoogleCredentialResolver({
      storage,
      clientId: "google-client",
      clientSecret: "google-secret",
    });

    await expect(
      resolver.getAuthClient({
        provider: "google",
        accountId: "acct_google_1",
        capabilities: ["gmail.read"],
        scopes: scopesForGoogleCapabilities(["gmail.read"]),
        reason: "unit-test",
      })
    ).rejects.toThrow("credential refs");
  });

  it("persists OAuth token material as vault-backed credential refs during callback", async () => {
    const vault = new Map<string, string>();
    const setCredentialRef = vi.fn(async () => undefined);
    const runtime = {
      agentId: "agent-1",
      getSetting: (key: string) =>
        ({
          GOOGLE_CLIENT_ID: "google-client",
          GOOGLE_CLIENT_SECRET: "google-secret",
          GOOGLE_REDIRECT_URI: "http://localhost:31437/api/connectors/google/oauth/callback",
        })[key],
      getService: (serviceType: string) =>
        serviceType === "vault"
          ? {
              set: async (key: string, value: string) => {
                vault.set(key, value);
              },
              remove: async (key: string) => {
                vault.delete(key);
              },
            }
          : null,
    } as never;
    const manager = createOAuthCallbackManager("google", "acct_google_durable_1", setCredentialRef);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const href = String(url);
        if (href.includes("oauth2.googleapis.com/token")) {
          return new Response(
            JSON.stringify({
              access_token: "google-access-token",
              refresh_token: "google-refresh-token",
              expires_in: 3600,
              scope: GOOGLE_OAUTH_SCOPES.gmail.read,
              token_type: "Bearer",
              id_token: createVerifiedJwt({
                sub: "google-subject",
                email: "ada@example.com",
                name: "Ada",
              }),
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (href.includes("oauth2.googleapis.com/revoke")) {
          return new Response(null, { status: 200 });
        }
        throw new Error(`Unexpected fetch ${href}`);
      })
    );

    const provider = createGoogleConnectorAccountProvider(runtime);
    const result = await provider.completeOAuth?.(
      {
        provider: "google",
        code: "oauth-code",
        query: {},
        flow: {
          id: "flow-1",
          provider: "google",
          state: "state-1",
          status: "pending",
          codeVerifier: "verifier",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          metadata: { requestedRole: "AGENT", oidcNonce: TEST_OIDC_NONCE },
        },
      },
      manager as never
    );

    const metadata = (result?.account as ConnectorAccount)?.metadata as Record<string, unknown>;
    const account = result?.account as ConnectorAccount;
    expect(account.id).toMatch(/^acct_google_[a-f0-9]{32}$/u);
    expect(account.role).toBe("AGENT");
    expect(JSON.stringify(metadata)).not.toContain("google-access-token");
    expect(JSON.stringify(metadata)).not.toContain("google-refresh-token");
    const [credentialRef] = metadata.credentialRefs as Array<{
      credentialType: string;
      vaultRef: string;
    }>;
    expect(credentialRef).toMatchObject({ credentialType: "oauth.tokens" });
    expect(credentialRef?.vaultRef).toMatch(
      new RegExp(`^connector\\.agent-1\\.google\\.${account.id}-[a-f0-9]+\\.oauth_tokens$`, "u")
    );
    expect(vault.get(credentialRef?.vaultRef ?? "")).toContain("google-access-token");
    expect(setCredentialRef).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: account.id,
        credentialType: "oauth.tokens",
        vaultRef: credentialRef?.vaultRef,
      })
    );
  });

  it("sanitizes provider-added scopes without rejecting a valid granted capability", async () => {
    const vault = new Map<string, string>();
    const runtime = {
      agentId: "agent-1",
      getSetting: (key: string) =>
        ({
          GOOGLE_CLIENT_ID: "google-client",
          GOOGLE_CLIENT_SECRET: "google-secret",
          GOOGLE_REDIRECT_URI: "http://localhost:31437/api/connectors/google/oauth/callback",
        })[key],
      getService: (serviceType: string) =>
        serviceType === "vault"
          ? {
              set: async (key: string, value: string) => {
                vault.set(key, value);
              },
              remove: async (key: string) => {
                vault.delete(key);
              },
            }
          : null,
    } as never;
    const manager = createOAuthCallbackManager(
      "google",
      "acct_google_incremental_grant",
      vi.fn(async () => undefined)
    );
    const provider = createGoogleConnectorAccountProvider(runtime);
    const providerAddedScope = "https://www.googleapis.com/auth/legacy.provider-added";
    const returnedScopes = [
      GOOGLE_OAUTH_SCOPES.profile.openid,
      GOOGLE_OAUTH_SCOPES.profile.email,
      GOOGLE_OAUTH_SCOPES.gmail.read,
      providerAddedScope,
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const href = String(url);
        if (href.includes("oauth2.googleapis.com/token")) {
          return new Response(
            JSON.stringify({
              access_token: "google-access-token",
              refresh_token: "google-refresh-token",
              expires_in: 3600,
              scope: returnedScopes.join(" "),
              token_type: "Bearer",
              id_token: createVerifiedJwt({
                sub: "google-subject",
                email: "ada@example.com",
              }),
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        throw new Error(`Unexpected fetch ${href}`);
      })
    );

    const result = await provider.completeOAuth?.(
      {
        provider: "google",
        code: "oauth-code",
        query: {},
        flow: {
          id: "flow-incremental-grant",
          provider: "google",
          state: "state-incremental-grant",
          status: "pending",
          codeVerifier: "verifier",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          metadata: {
            requestedRole: "OWNER",
            oidcNonce: TEST_OIDC_NONCE,
            requestedCapabilities: ["gmail.read"],
            requestedScopes: scopesForGoogleCapabilities(["gmail.read"]),
          },
        },
      },
      manager as never
    );

    const account = result?.account as ConnectorAccount;
    const metadata = account.metadata as Record<string, unknown>;
    expect(account.purpose).toEqual(["messaging"]);
    expect(metadata.grantedCapabilities).toEqual(["gmail.read"]);
    expect(metadata.grantedScopes).toEqual(returnedScopes);
    const [credentialRef] = metadata.credentialRefs as Array<{
      credentialType: string;
      vaultRef: string;
    }>;
    expect(credentialRef?.vaultRef).toMatch(
      new RegExp(`^connector\\.agent-1\\.google\\.${account.id}-[a-f0-9]+\\.oauth_tokens$`, "u")
    );
    expect(vault.get(credentialRef?.vaultRef ?? "")).toContain(providerAddedScope);
  });

  it("does not record or re-request a compound capability from a partial provider grant", async () => {
    const vault = new Map<string, string>();
    const runtime = {
      agentId: "agent-1",
      getSetting: (key: string) =>
        ({
          GOOGLE_CLIENT_ID: "google-client",
          GOOGLE_CLIENT_SECRET: "google-secret",
          GOOGLE_REDIRECT_URI: "http://localhost:31437/api/connectors/google/oauth/callback",
        })[key],
      getService: (serviceType: string) =>
        serviceType === "vault"
          ? {
              set: async (key: string, value: string) => {
                vault.set(key, value);
              },
              remove: async (key: string) => {
                vault.delete(key);
              },
            }
          : null,
    } as never;
    const manager = createOAuthCallbackManager(
      "google",
      "acct_google_partial_compound",
      vi.fn(async () => undefined)
    );
    const provider = createGoogleConnectorAccountProvider(runtime);
    const returnedScopes = [
      GOOGLE_OAUTH_SCOPES.profile.openid,
      GOOGLE_OAUTH_SCOPES.profile.email,
      GOOGLE_OAUTH_SCOPES.gmail.read,
      GOOGLE_OAUTH_SCOPES.gmail.manage,
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const href = String(url);
        if (href.includes("oauth2.googleapis.com/token")) {
          return new Response(
            JSON.stringify({
              access_token: "google-access-token",
              refresh_token: "google-refresh-token",
              expires_in: 3600,
              scope: returnedScopes.join(" "),
              token_type: "Bearer",
              id_token: createVerifiedJwt({
                sub: "google-subject",
                email: "ada@example.com",
              }),
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (href.includes("oauth2.googleapis.com/revoke")) {
          return new Response(null, { status: 200 });
        }
        throw new Error(`Unexpected fetch ${href}`);
      })
    );

    const result = await provider.completeOAuth?.(
      {
        provider: "google",
        code: "oauth-code",
        query: {},
        flow: {
          id: "flow-partial-compound",
          provider: "google",
          state: "state-partial-compound",
          status: "pending",
          codeVerifier: "verifier",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          metadata: {
            requestedRole: "OWNER",
            oidcNonce: TEST_OIDC_NONCE,
            requestedCapabilities: ["gmail.read", "gmail.manage"],
            requestedScopes: scopesForGoogleCapabilities(["gmail.read", "gmail.manage"]),
          },
        },
      },
      manager as never
    );

    const account = result?.account as ConnectorAccount;
    const metadata = account.metadata as Record<string, unknown>;
    expect(metadata.grantedCapabilities).toEqual(["gmail.read"]);
    expect(metadata.grantedCapabilities).not.toContain("gmail.manage");
    expect(metadata.grantedScopes).toEqual(returnedScopes);

    const reauthResult = await provider.startOAuth?.(
      {
        provider: "google",
        accountId: account.id,
        flow: {
          id: "flow-partial-compound-reauth",
          provider: "google",
          state: "state-partial-compound-reauth",
          status: "pending",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
      {
        getAccount: vi.fn(async () => account),
      } as never
    );
    const requestedScopes = new Set(
      new URL(reauthResult?.authUrl ?? "").searchParams.get("scope")?.split(" ") ?? []
    );
    expect(requestedScopes).toContain(GOOGLE_OAUTH_SCOPES.gmail.read);
    expect(requestedScopes).not.toContain(GOOGLE_OAUTH_SCOPES.gmail.manage);
    expect(requestedScopes).not.toContain(GOOGLE_OAUTH_SCOPES.gmail.settings);
  });

  it("fails an OAuth callback that grants identity but no connector capability", async () => {
    const runtime = {
      agentId: "agent-1",
      getSetting: (key: string) =>
        ({
          GOOGLE_CLIENT_ID: "google-client",
          GOOGLE_CLIENT_SECRET: "google-secret",
          GOOGLE_REDIRECT_URI: "http://localhost:31437/api/connectors/google/oauth/callback",
        })[key],
      getService: () => null,
    } as never;
    const manager = createOAuthCallbackManager(
      "google",
      "acct_google_identity_only",
      vi.fn(async () => undefined)
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const href = String(url);
        if (href.includes("oauth2.googleapis.com/token")) {
          return new Response(
            JSON.stringify({
              access_token: "google-access-token",
              expires_in: 3600,
              scope: [GOOGLE_OAUTH_SCOPES.profile.openid, GOOGLE_OAUTH_SCOPES.profile.email].join(
                " "
              ),
              token_type: "Bearer",
              id_token: createVerifiedJwt({
                sub: "google-subject",
                email: "ada@example.com",
              }),
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (href.includes("oauth2.googleapis.com/revoke")) {
          return new Response(null, { status: 200 });
        }
        throw new Error(`Unexpected fetch ${href}`);
      })
    );
    const provider = createGoogleConnectorAccountProvider(runtime);

    await expect(
      provider.completeOAuth?.(
        {
          provider: "google",
          code: "oauth-code",
          query: {},
          flow: {
            id: "flow-identity-only",
            provider: "google",
            state: "state-identity-only",
            status: "pending",
            codeVerifier: "verifier",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            metadata: {
              requestedCapabilities: ["gmail.read"],
              requestedScopes: scopesForGoogleCapabilities(["gmail.read"]),
            },
          },
        },
        manager as never
      )
    ).rejects.toThrow(
      "Google OAuth completed without a usable Gmail, Calendar, Drive, or Meet capability."
    );
    expect(manager.upsertAccount).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "rejects a non-string provider scope field",
      tokenFields: {
        scope: [GOOGLE_OAUTH_SCOPES.gmail.read],
      },
      metadata: {
        requestedScopes: scopesForGoogleCapabilities(["gmail.read"]),
      },
      expectedMessage: "Google token exchange returned an invalid scope field.",
    },
    {
      label: "fails closed when both provider and request scope evidence are absent",
      tokenFields: {},
      metadata: {},
      expectedMessage:
        "Google OAuth callback is missing the scopes bound to the authorization request.",
    },
  ])("$label", async ({ tokenFields, metadata, expectedMessage }) => {
    const runtime = {
      agentId: "agent-1",
      getSetting: (key: string) =>
        ({
          GOOGLE_CLIENT_ID: "google-client",
          GOOGLE_CLIENT_SECRET: "google-secret",
          GOOGLE_REDIRECT_URI: "http://localhost:31437/api/connectors/google/oauth/callback",
        })[key],
      getService: () => null,
      adapter: {
        deleteConnectorAccountCredentialRefs: vi.fn(async () => 0),
        setConnectorAccountCredentialRef: vi.fn(async () => undefined),
      },
    } as never;
    const manager = createOAuthCallbackManager(
      "google",
      "acct_google_invalid_scope",
      vi.fn(async () => undefined)
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const href = String(url);
        if (href.includes("oauth2.googleapis.com/token")) {
          return new Response(
            JSON.stringify({
              access_token: "google-access-token",
              expires_in: 3600,
              token_type: "Bearer",
              ...tokenFields,
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (href.includes("oauth2.googleapis.com/revoke")) {
          return new Response(null, { status: 200 });
        }
        throw new Error(`Unexpected fetch ${href}`);
      })
    );
    const provider = createGoogleConnectorAccountProvider(runtime);

    await expect(
      provider.completeOAuth?.(
        {
          provider: "google",
          code: "oauth-code",
          query: {},
          flow: {
            id: "flow-invalid-scope",
            provider: "google",
            state: "state-invalid-scope",
            status: "pending",
            codeVerifier: "verifier",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            metadata,
          },
        },
        manager as never
      )
    ).rejects.toThrow(expectedMessage);
    expect(manager.upsertAccount).not.toHaveBeenCalled();
  });

  it("fails OAuth callback when no durable credential writer is available", async () => {
    const runtime = {
      agentId: "agent-1",
      getSetting: (key: string) =>
        ({
          GOOGLE_CLIENT_ID: "google-client",
          GOOGLE_CLIENT_SECRET: "google-secret",
          GOOGLE_REDIRECT_URI: "http://localhost:31437/api/connectors/google/oauth/callback",
        })[key],
      getService: () => null,
      adapter: {
        deleteConnectorAccountCredentialRefs: vi.fn(async () => 0),
        setConnectorAccountCredentialRef: vi.fn(async () => undefined),
      },
    } as never;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const href = String(url);
        if (href.includes("oauth2.googleapis.com/token")) {
          return new Response(
            JSON.stringify({
              access_token: "google-access-token",
              refresh_token: "google-refresh-token",
              expires_in: 3600,
              scope: GOOGLE_OAUTH_SCOPES.gmail.read,
              token_type: "Bearer",
              id_token: createVerifiedJwt({
                sub: "google-subject",
                email: "ada@example.com",
              }),
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (href.includes("oauth2.googleapis.com/revoke")) {
          return new Response(null, { status: 200 });
        }
        throw new Error(`Unexpected fetch ${href}`);
      })
    );

    const provider = createGoogleConnectorAccountProvider(runtime);
    const manager = createOAuthCallbackManager(
      "google",
      "acct_google_durable_1",
      vi.fn(async () => undefined)
    );
    await expect(
      provider.completeOAuth?.(
        {
          provider: "google",
          code: "oauth-code",
          query: {},
          flow: {
            id: "flow-1",
            provider: "google",
            state: "state-1",
            status: "pending",
            codeVerifier: "verifier",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            metadata: { requestedRole: "OWNER", oidcNonce: TEST_OIDC_NONCE },
          },
        },
        manager as never
      )
    ).rejects.toThrow(/durable connector credential store|vault writer/i);
  });

  it("uses a fake Gmail client with selected Gmail read/send scopes", async () => {
    const fakeGmail = {
      users: {
        messages: {
          list: vi.fn(async () => ({ data: { messages: [{ id: "msg_1" }] } })),
          get: vi.fn(async () => ({
            data: {
              id: "msg_1",
              threadId: "thread_1",
              snippet: "Hello",
              payload: {
                headers: [
                  { name: "Subject", value: "Status" },
                  { name: "From", value: "Ada <ada@example.com>" },
                  { name: "To", value: "Grace <grace@example.com>" },
                  { name: "Date", value: "Thu, 07 May 2026 12:00:00 GMT" },
                ],
              },
            },
          })),
          send: vi.fn(async () => ({ data: { id: "sent_1", threadId: "thread_2" } })),
        },
      },
    };
    const factory = {
      gmail: vi.fn(async () => fakeGmail),
    } as GoogleApiClientFactory;
    const client = new GoogleGmailClient(factory);

    const results = await client.searchMessages({
      accountId: "acct_google_1",
      query: "from:ada",
      limit: 1,
    });
    const sent = await client.sendEmail({
      accountId: "acct_google_1",
      to: [{ email: "grace@example.com", name: "Grace" }],
      subject: "Status",
      text: "Done",
    });

    expect(factory.gmail).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ accountId: "acct_google_1" }),
      ["gmail.read"],
      "gmail.searchMessages"
    );
    expect(factory.gmail).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ accountId: "acct_google_1" }),
      ["gmail.send"],
      "gmail.sendEmail"
    );
    expect(fakeGmail.users.messages.list).toHaveBeenCalledWith({
      userId: "me",
      q: "from:ada",
      maxResults: 1,
    });
    expect(fakeGmail.users.messages.get).toHaveBeenCalledWith({
      userId: "me",
      id: "msg_1",
      format: "metadata",
      metadataHeaders: ["Subject", "From", "To", "Date"],
    });
    expect(results[0]?.from).toEqual({ name: "Ada", email: "ada@example.com" });
    expect(sent).toEqual({ id: "sent_1", threadId: "thread_2" });
  });

  it("exposes rich Gmail management methods for LifeOps delegation", async () => {
    const bodyText = Buffer.from("Please reply today", "utf8").toString("base64url");
    const fakeGmail = {
      users: {
        messages: {
          list: vi.fn(async () => ({ data: { messages: [{ id: "msg_1" }] } })),
          get: vi.fn(async () => ({
            data: {
              id: "msg_1",
              threadId: "thread_1",
              labelIds: ["INBOX", "UNREAD"],
              snippet: "Please reply",
              internalDate: String(Date.parse("2026-05-07T12:00:00.000Z")),
              payload: {
                mimeType: "text/plain",
                body: { data: bodyText },
                headers: [
                  { name: "Subject", value: "Need response" },
                  { name: "From", value: "Ada <ada@example.com>" },
                  { name: "To", value: "Grace <grace@example.com>" },
                  { name: "Date", value: "Thu, 07 May 2026 12:00:00 GMT" },
                  { name: "Message-Id", value: "<msg_1@example.com>" },
                  { name: "List-Unsubscribe", value: "<mailto:leave@example.com>" },
                  { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
                ],
              },
            },
          })),
          send: vi.fn(async () => ({
            data: { id: "sent_1", threadId: "thread_1", labelIds: ["SENT"] },
          })),
          batchModify: vi.fn(async () => ({ data: {} })),
          batchDelete: vi.fn(async () => ({ data: {} })),
          trash: vi.fn(async () => ({ data: {} })),
          modify: vi.fn(async () => ({ data: {} })),
        },
        threads: {
          trash: vi.fn(async () => ({ data: {} })),
        },
        settings: {
          filters: {
            create: vi.fn(async () => ({ data: { id: "filter_1" } })),
          },
        },
      },
    };
    const factory = {
      gmail: vi.fn(async () => fakeGmail),
    } as GoogleApiClientFactory;
    const client = new GoogleGmailClient(factory);

    await expect(
      client.searchGmailMessages({
        accountId: "acct_google_1",
        query: "in:inbox",
        selfEmail: "grace@example.com",
        maxResults: 1,
      })
    ).resolves.toMatchObject([
      {
        externalId: "msg_1",
        threadId: "thread_1",
        subject: "Need response",
        fromEmail: "ada@example.com",
        isUnread: true,
        likelyReplyNeeded: true,
        metadata: {
          listUnsubscribe: "<mailto:leave@example.com>",
          listUnsubscribePost: "List-Unsubscribe=One-Click",
        },
      },
    ]);
    await expect(
      client.getGmailMessageDetail({
        accountId: "acct_google_1",
        messageId: "msg_1",
        selfEmail: "grace@example.com",
      })
    ).resolves.toMatchObject({
      message: { externalId: "msg_1" },
      bodyText: "Please reply today",
    });
    await expect(
      client.getGmailSubscriptionHeaders({
        accountId: "acct_google_1",
        query: "unsubscribe",
        maxMessages: 1,
      })
    ).resolves.toMatchObject([
      {
        messageId: "msg_1",
        listUnsubscribe: "<mailto:leave@example.com>",
        listUnsubscribePost: "List-Unsubscribe=One-Click",
      },
    ]);
    await client.modifyGmailMessages({
      accountId: "acct_google_1",
      messageIds: ["msg_1"],
      operation: "mark_read",
    });
    await expect(
      client.sendGmailReply({
        accountId: "acct_google_1",
        to: ["ada@example.com"],
        subject: "Need response",
        bodyText: "Done",
        inReplyTo: "<msg_1@example.com>",
      })
    ).resolves.toEqual({ messageId: "sent_1", threadId: "thread_1", labelIds: ["SENT"] });
    await expect(
      client.createGmailFilterForSender({
        accountId: "acct_google_1",
        fromAddress: "alerts@example.com",
        trash: true,
      })
    ).resolves.toEqual({ filterId: "filter_1", trashed: true });
    await client.trashGmailThread({ accountId: "acct_google_1", threadId: "thread_1" });

    expect(fakeGmail.users.messages.batchModify).toHaveBeenCalledWith({
      userId: "me",
      requestBody: {
        ids: ["msg_1"],
        addLabelIds: undefined,
        removeLabelIds: ["UNREAD"],
      },
    });
    expect(fakeGmail.users.settings.filters.create).toHaveBeenCalledWith({
      userId: "me",
      requestBody: {
        criteria: { from: "alerts@example.com" },
        action: { removeLabelIds: ["INBOX"], addLabelIds: ["TRASH"] },
      },
    });
    expect(fakeGmail.users.threads.trash).toHaveBeenCalledWith({
      userId: "me",
      id: "thread_1",
    });
  });

  it("rejects hostile Gmail result limits before listing messages", async () => {
    const fakeGmail = {
      users: {
        messages: {
          list: vi.fn(async () => ({
            data: { messages: [] },
          })),
          get: vi.fn(),
        },
      },
    };
    const factory = { gmail: vi.fn(async () => fakeGmail) } as GoogleApiClientFactory;
    const client = new GoogleGmailClient(factory);

    await expect(
      client.searchGmailMessages({
        accountId: "acct_google_1",
        query: "in:inbox",
        maxResults: Number.POSITIVE_INFINITY,
      })
    ).rejects.toMatchObject({ code: "GOOGLE_GMAIL_LIMIT_INVALID" });
    await expect(
      client.listGmailUnrespondedThreads({
        accountId: "acct_google_1",
        olderThanDays: -4,
        maxResults: Number.NaN,
      })
    ).rejects.toMatchObject({ code: "GOOGLE_GMAIL_LIMIT_INVALID" });
    expect(fakeGmail.users.messages.list).not.toHaveBeenCalled();
  });

  it("escapes Drive folder IDs and preserves explicit trashed predicates", async () => {
    const fakeDrive = {
      files: {
        list: vi.fn(async () => ({ data: { files: [] } })),
      },
    };
    const factory = { drive: vi.fn(async () => fakeDrive) } as GoogleApiClientFactory;
    const client = new GoogleDriveClient(factory);

    await client.listDriveFiles({
      accountId: "acct_google_1",
      folderId: "root' OR trashed = true OR 'x",
      maxResults: Number.NEGATIVE_INFINITY,
    });
    await client.searchDriveFiles({
      accountId: "acct_google_1",
      query: "name contains 'Plan' and trashed = true",
      maxResults: 1.9,
    });

    expect(fakeDrive.files.list).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        q: "'root\\' OR trashed = true OR \\'x' in parents and trashed = false",
        pageSize: 25,
      })
    );
    expect(fakeDrive.files.list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        q: "name contains 'Plan' and trashed = true",
        pageSize: 1,
      })
    );
  });

  it("uses fake Calendar, Drive, and Meet clients with narrow capabilities", async () => {
    const fakeCalendar = {
      calendarList: {
        list: vi.fn(async () => ({
          data: {
            items: [
              {
                id: "primary",
                summary: "Owner",
                primary: true,
                accessRole: "owner",
                timeZone: "America/Los_Angeles",
              },
            ],
          },
        })),
      },
      events: {
        list: vi.fn(async () => ({
          data: {
            items: [
              {
                id: "event_1",
                summary: "Planning",
                start: { dateTime: "2026-05-07T09:00:00-07:00" },
                end: { dateTime: "2026-05-07T09:30:00-07:00" },
              },
            ],
          },
        })),
        get: vi.fn(async () => ({
          data: {
            id: "event_1",
            summary: "Planning",
            start: { dateTime: "2026-05-07T09:00:00-07:00" },
            end: { dateTime: "2026-05-07T09:30:00-07:00" },
          },
        })),
        patch: vi.fn(async () => ({
          data: {
            id: "event_1",
            summary: "Updated Planning",
            start: { dateTime: "2026-05-07T10:00:00-07:00" },
            end: { dateTime: "2026-05-07T10:30:00-07:00" },
          },
        })),
        delete: vi.fn(async () => ({ data: {} })),
      },
    };
    const fakeDrive = {
      files: {
        list: vi.fn(async () => ({
          data: {
            files: [
              {
                id: "file_1",
                name: "Plan",
                mimeType: "application/vnd.google-apps.document",
                webViewLink: "https://docs.google.com/document/d/file_1",
                parents: ["root"],
              },
            ],
          },
        })),
        get: vi.fn(async () => ({
          data: {
            id: "file_1",
            name: "Plan",
            mimeType: "application/vnd.google-apps.document",
            webViewLink: "https://docs.google.com/document/d/file_1",
            parents: ["root"],
          },
        })),
        create: vi.fn(async () => ({
          data: {
            id: "file_2",
            name: "Notes",
            mimeType: "text/plain",
          },
        })),
      },
    };
    const fakeDocs = {
      documents: {
        get: vi.fn(async () => ({
          data: {
            title: "Notes",
            body: {
              content: [{ paragraph: { elements: [{ textRun: { content: "Hello" } }] } }],
            },
          },
        })),
        batchUpdate: vi.fn(async () => ({ data: {} })),
      },
    };
    const fakeSheets = {
      spreadsheets: {
        get: vi.fn(async () => ({
          data: {
            sheets: [
              {
                properties: { title: "Sheet1" },
                data: [{ rowData: [{ values: [{ formattedValue: "A1" }] }] }],
              },
            ],
          },
        })),
        values: {
          update: vi.fn(async () => ({ data: { updatedRange: "Sheet1!A1", updatedCells: 1 } })),
        },
      },
    };
    const fakeMeet = {
      spaces: {
        create: vi.fn(async () => ({
          data: {
            name: "spaces/abc-defg-hij",
            meetingCode: "abc-defg-hij",
            meetingUri: "https://meet.google.com/abc-defg-hij",
            config: { accessType: "TRUSTED" },
          },
        })),
      },
    };
    const factory = {
      calendar: vi.fn(async () => fakeCalendar),
      drive: vi.fn(async () => fakeDrive),
      docs: vi.fn(async () => fakeDocs),
      sheets: vi.fn(async () => fakeSheets),
      meet: vi.fn(async () => fakeMeet),
    } as GoogleApiClientFactory;

    const calendarClient = new GoogleCalendarClient(factory);
    const driveClient = new GoogleDriveClient(factory);
    const meetClient = new GoogleMeetClient(factory);

    await expect(calendarClient.listCalendars({ accountId: "acct_google_1" })).resolves.toEqual([
      {
        calendarId: "primary",
        summary: "Owner",
        description: null,
        primary: true,
        accessRole: "owner",
        backgroundColor: null,
        foregroundColor: null,
        timeZone: "America/Los_Angeles",
        selected: true,
      },
    ]);
    await expect(
      calendarClient.listEvents({ accountId: "acct_google_1", limit: 1 })
    ).resolves.toMatchObject([
      {
        id: "event_1",
        calendarId: "primary",
        title: "Planning",
        start: "2026-05-07T16:00:00.000Z",
        end: "2026-05-07T16:30:00.000Z",
        isAllDay: false,
        timeZone: null,
        metadata: {
          iCalUID: null,
          recurringEventId: null,
          createdAt: null,
          updatedAt: null,
        },
      },
    ]);
    await expect(
      calendarClient.getEvent({ accountId: "acct_google_1", eventId: "event_1" })
    ).resolves.toMatchObject({
      id: "event_1",
      start: "2026-05-07T16:00:00.000Z",
    });
    await expect(
      calendarClient.updateEvent({
        accountId: "acct_google_1",
        eventId: "event_1",
        title: "Updated Planning",
      })
    ).resolves.toMatchObject({
      id: "event_1",
      title: "Updated Planning",
    });
    await expect(
      calendarClient.deleteEvent({ accountId: "acct_google_1", eventId: "event_1" })
    ).resolves.toBeUndefined();
    await expect(
      driveClient.searchFiles({
        accountId: "acct_google_1",
        query: "name contains 'Plan'",
        limit: 1,
      })
    ).resolves.toMatchObject([{ id: "file_1", name: "Plan", parents: ["root"] }]);
    await expect(
      driveClient.getFile({ accountId: "acct_google_1", fileId: "file_1" })
    ).resolves.toMatchObject({ id: "file_1", name: "Plan", parents: ["root"] });
    await expect(
      driveClient.listDriveFiles({ accountId: "acct_google_1", folderId: "root", maxResults: 1 })
    ).resolves.toMatchObject({
      files: [{ id: "file_1", name: "Plan", parents: ["root"] }],
      nextPageToken: null,
    });
    await expect(
      driveClient.getDocContent({ accountId: "acct_google_1", documentId: "doc_1" })
    ).resolves.toEqual({ title: "Notes", plainText: "Hello" });
    await expect(
      driveClient.getSheetContent({ accountId: "acct_google_1", spreadsheetId: "sheet_1" })
    ).resolves.toEqual({ title: "Sheet1", rows: [["A1"]] });
    await expect(
      driveClient.createDriveFile({
        accountId: "acct_google_1",
        name: "Notes",
        mimeType: "text/plain",
        content: "Hello",
      })
    ).resolves.toMatchObject({ id: "file_2", name: "Notes" });
    await expect(
      driveClient.updateSheetCells({
        accountId: "acct_google_1",
        spreadsheetId: "sheet_1",
        range: "Sheet1!A1",
        values: [["A1"]],
      })
    ).resolves.toEqual({ updatedRange: "Sheet1!A1", updatedCells: 1 });
    await expect(
      driveClient.appendToDoc({ accountId: "acct_google_1", documentId: "doc_1", text: "Later" })
    ).resolves.toBeUndefined();
    await expect(
      meetClient.createMeeting({
        accountId: "acct_google_1",
        title: "Planning",
        accessType: "TRUSTED",
      })
    ).resolves.toMatchObject({
      id: "spaces/abc-defg-hij",
      meetingUri: "https://meet.google.com/abc-defg-hij",
      accessType: "TRUSTED",
      status: GoogleMeetStatus.WAITING,
    });

    expect(fakeCalendar.calendarList.list).toHaveBeenCalledWith({
      minAccessRole: "reader",
      showDeleted: false,
      showHidden: false,
    });
    expect(fakeCalendar.events.patch).toHaveBeenCalledWith({
      calendarId: "primary",
      eventId: "event_1",
      sendUpdates: "none",
      requestBody: { summary: "Updated Planning" },
    });
    expect(fakeCalendar.events.delete).toHaveBeenCalledWith({
      calendarId: "primary",
      eventId: "event_1",
      sendUpdates: "none",
    });
    expect(fakeDrive.files.list).toHaveBeenCalledWith({
      q: "(name contains 'Plan') and trashed = false",
      pageSize: 1,
      pageToken: undefined,
      orderBy: "modifiedTime desc",
      fields:
        "nextPageToken,files(id,name,mimeType,createdTime,webViewLink,modifiedTime,size,parents)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    expect(factory.calendar).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ accountId: "acct_google_1" }),
      ["calendar.read"],
      "calendar.listCalendars"
    );
    expect(factory.calendar).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ accountId: "acct_google_1" }),
      ["calendar.read"],
      "calendar.listEvents"
    );
    expect(factory.calendar).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ accountId: "acct_google_1" }),
      ["calendar.read"],
      "calendar.getEvent"
    );
    expect(factory.calendar).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ accountId: "acct_google_1" }),
      ["calendar.write"],
      "calendar.updateEvent"
    );
    expect(factory.calendar).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({ accountId: "acct_google_1" }),
      ["calendar.write"],
      "calendar.deleteEvent"
    );
    expect(factory.drive).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ accountId: "acct_google_1" }),
      ["drive.read"],
      "drive.searchDriveFiles"
    );
    expect(factory.drive).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ accountId: "acct_google_1" }),
      ["drive.read"],
      "drive.getFile"
    );
    expect(factory.drive).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ accountId: "acct_google_1" }),
      ["drive.read"],
      "drive.listFiles"
    );
    expect(factory.docs).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ accountId: "acct_google_1" }),
      ["drive.read"],
      "drive.getDocContent"
    );
    expect(factory.sheets).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ accountId: "acct_google_1" }),
      ["drive.read"],
      "drive.getSheetContent"
    );
    expect(factory.drive).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ accountId: "acct_google_1" }),
      ["drive.write"],
      "drive.createFile"
    );
    expect(factory.sheets).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ accountId: "acct_google_1" }),
      ["drive.write"],
      "drive.updateSheetCells"
    );
    expect(factory.docs).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ accountId: "acct_google_1" }),
      ["drive.write"],
      "drive.appendToDoc"
    );
    expect(factory.meet).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acct_google_1" }),
      ["meet.create"],
      "meet.createMeeting"
    );
  });

  it("passes RFC 5545 recurrence through create/patch and maps it on readback", async () => {
    const fakeCalendar = {
      events: {
        insert: vi.fn(async () => ({
          data: {
            id: "series_master",
            summary: "Standup",
            start: { dateTime: "2026-07-06T09:00:00-04:00", timeZone: "America/New_York" },
            end: { dateTime: "2026-07-06T09:15:00-04:00", timeZone: "America/New_York" },
            recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
          },
        })),
        patch: vi.fn(async () => ({
          data: {
            id: "series_master",
            summary: "Standup",
            start: { dateTime: "2026-07-06T09:00:00-04:00", timeZone: "America/New_York" },
            end: { dateTime: "2026-07-06T09:15:00-04:00", timeZone: "America/New_York" },
            recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"],
          },
        })),
        list: vi.fn(async () => ({
          data: {
            items: [
              {
                id: "series_master_20260713T130000Z",
                summary: "Standup",
                start: { dateTime: "2026-07-13T09:00:00-04:00" },
                end: { dateTime: "2026-07-13T09:15:00-04:00" },
                recurringEventId: "series_master",
              },
            ],
          },
        })),
      },
    };
    const factory = {
      calendar: vi.fn(async () => fakeCalendar),
    } as unknown as GoogleApiClientFactory;
    const client = new GoogleCalendarClient(factory);

    // create: recurrence lines land in the insert requestBody and readback
    // exposes them first-class + in metadata.
    const created = await client.createEvent({
      accountId: "acct_google_1",
      title: "Standup",
      start: "2026-07-06T13:00:00.000Z",
      end: "2026-07-06T13:15:00.000Z",
      timeZone: "America/New_York",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
    });
    expect(fakeCalendar.events.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
        }),
      })
    );
    expect(created.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO"]);
    expect(created.recurringEventId).toBeNull();
    expect(created.metadata).toMatchObject({
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
    });

    // patch: recurrence replacement flows through; omitting it leaves the
    // requestBody untouched (no accidental recurrence clears).
    await client.updateEvent({
      accountId: "acct_google_1",
      eventId: "series_master",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"],
    });
    expect(fakeCalendar.events.patch).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "series_master",
        requestBody: { recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"] },
      })
    );

    // flattened instances keep the series pointer first-class.
    const [instance] = await client.listEvents({ accountId: "acct_google_1" });
    expect(instance?.recurringEventId).toBe("series_master");
    expect(instance?.recurrence).toBeNull();
  });
});

interface TestCredentialRecord {
  credentialType: string;
  vaultRef?: string;
  value?: string;
  updatedAt?: string | number;
  expiresAt?: string | number;
}

function createCredentialStorage(options: {
  records: TestCredentialRecord[];
  metadata?: ConnectorAccount["metadata"];
}): ConnectorAccountStorage & {
  listConnectorAccountCredentialRefs(params: {
    accountId: string;
  }): Promise<TestCredentialRecord[]>;
} {
  const account: ConnectorAccount = {
    id: "acct_google_1",
    provider: "google",
    label: "Google User",
    role: "OWNER",
    purpose: ["reading"],
    accessGate: "open",
    status: "connected",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: options.metadata ?? {},
  };

  return {
    async listAccounts(provider?: string) {
      return !provider || provider === "google" ? [account] : [];
    },
    async getAccount(provider: string, accountId: string) {
      return provider === "google" && accountId === account.id ? account : null;
    },
    async upsertAccount(next: ConnectorAccount) {
      return next;
    },
    async deleteAccount() {
      return false;
    },
    async createOAuthFlow(flow) {
      return flow;
    },
    async getOAuthFlow() {
      return null;
    },
    async updateOAuthFlow() {
      return null;
    },
    async deleteOAuthFlow() {
      return false;
    },
    async listConnectorAccountCredentialRefs() {
      return options.records;
    },
  };
}

function createVerifiedJwt(payload: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const verifiedPayload = {
    iss: "https://accounts.google.com",
    aud: "google-client",
    iat: now - 10,
    exp: now + 3600,
    nonce: TEST_OIDC_NONCE,
    ...payload,
  };
  vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({
    getPayload: () => verifiedPayload,
  } as never);
  return [
    Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString("base64url"),
    Buffer.from(JSON.stringify(verifiedPayload)).toString("base64url"),
    "sig",
  ].join(".");
}

function createOAuthCallbackManager(
  provider: string,
  durableAccountId: string,
  setCredentialRef: ReturnType<typeof vi.fn>
) {
  const upsertStoredAccount = vi.fn(async (account: ConnectorAccount) => account);
  const deleteStoredAccount = vi.fn(async () => false);
  return {
    listAccounts: vi.fn(async () => []),
    getStorage: () => ({
      setConnectorAccountCredentialRef: setCredentialRef,
      upsertAccount: upsertStoredAccount,
      deleteAccount: deleteStoredAccount,
    }),
    upsertAccount: vi.fn(
      async (
        providerId: string,
        input: ConnectorAccountPatch & { provider?: string },
        accountId?: string
      ): Promise<ConnectorAccount> => ({
        id: accountId ?? durableAccountId,
        provider: providerId || provider,
        label: input.label,
        role: input.role ?? "OWNER",
        purpose: Array.isArray(input.purpose)
          ? input.purpose
          : input.purpose
            ? [input.purpose]
            : ["messaging"],
        accessGate: input.accessGate ?? "open",
        status: input.status ?? "pending",
        externalId: input.externalId ?? undefined,
        displayHandle: input.displayHandle ?? undefined,
        ownerBindingId: input.ownerBindingId ?? undefined,
        ownerIdentityId: input.ownerIdentityId ?? undefined,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: input.metadata,
      })
    ),
  };
}
