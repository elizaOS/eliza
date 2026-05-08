import type {
  ConnectorAccount,
  ConnectorAccountPatch,
  ConnectorAccountStorage,
  IAgentRuntime,
} from "@elizaos/core";
import { getConnectorAccountManager } from "@elizaos/core";
import { OAuth2Client } from "google-auth-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import googlePlugin, {
  createGoogleConnectorAccountProvider,
  DefaultGoogleCredentialResolver,
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

describe("google plugin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("exports one Google Workspace plugin with the workspace service", () => {
    expect(googlePlugin.name).toBe("google");
    expect(googlePlugin.description).toContain("Gmail, Calendar, Drive, and Meet");
    expect(googlePlugin.description).not.toContain("Chat");
    expect(googlePlugin.services).toContain(GoogleWorkspaceService);
  });

  it("registers the Google connector account provider on init", async () => {
    const runtime = {
      getService: vi.fn(() => null),
      getSetting: vi.fn(() => undefined),
    } as unknown as IAgentRuntime;

    await googlePlugin.init?.({}, runtime);

    expect(getConnectorAccountManager(runtime).getProvider("google")).toEqual(
      expect.objectContaining({
        provider: "google",
        startOAuth: expect.any(Function),
        completeOAuth: expect.any(Function),
      })
    );
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

  it("normalizes capability input and preserves opt-in OAuth metadata", () => {
    const config = getGoogleOAuthProviderConfig(
      normalizeGoogleCapabilities(["drive.read", "drive.read", "meet.read", "unknown"])
    );

    expect(config.provider).toBe("google");
    expect(config.capabilities).toEqual(["drive.read", "meet.read"]);
    expect(config.scopes).toContain(GOOGLE_OAUTH_SCOPES.drive.read);
    expect(config.scopes).toContain(GOOGLE_OAUTH_SCOPES.meet.read);
    expect(config.scopes).not.toContain(GOOGLE_OAUTH_SCOPES.gmail.send);
    expect(config.authorizationParams.include_granted_scopes).toBe("true");
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
      redirectUri: "http://localhost/oauth/google/callback",
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
          GOOGLE_REDIRECT_URI: "http://localhost/oauth/google/callback",
        })[key],
      getService: (serviceType: string) =>
        serviceType === "vault"
          ? {
              set: async (key: string, value: string) => {
                vault.set(key, value);
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
              id_token: createUnsignedJwt({
                sub: "google-subject",
                email: "ada@example.com",
                name: "Ada",
              }),
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
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
          metadata: { requestedRole: "AGENT" },
        },
      },
      manager as never
    );

    const metadata = (result?.account as ConnectorAccount)?.metadata as Record<string, unknown>;
    expect((result?.account as ConnectorAccount)?.id).toBe("acct_google_durable_1");
    expect((result?.account as ConnectorAccount)?.role).toBe("AGENT");
    expect(JSON.stringify(metadata)).not.toContain("google-access-token");
    expect(JSON.stringify(metadata)).not.toContain("google-refresh-token");
    expect(metadata.credentialRefs).toEqual([
      expect.objectContaining({
        credentialType: "oauth.tokens",
        vaultRef: "connector.agent-1.google.acct_google_durable_1.oauth_tokens",
      }),
    ]);
    expect(vault.get("connector.agent-1.google.acct_google_durable_1.oauth_tokens")).toContain(
      "google-access-token"
    );
    expect(setCredentialRef).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct_google_durable_1",
        credentialType: "oauth.tokens",
        vaultRef: "connector.agent-1.google.acct_google_durable_1.oauth_tokens",
      })
    );
  });

  it("fails OAuth callback when no durable credential writer is available", async () => {
    const runtime = {
      agentId: "agent-1",
      getSetting: (key: string) =>
        ({
          GOOGLE_CLIENT_ID: "google-client",
          GOOGLE_CLIENT_SECRET: "google-secret",
          GOOGLE_REDIRECT_URI: "http://localhost/oauth/google/callback",
        })[key],
      getService: () => null,
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
              id_token: createUnsignedJwt({
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
            metadata: {},
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
    } as unknown as GoogleApiClientFactory;
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
      meet: vi.fn(async () => fakeMeet),
    } as unknown as GoogleApiClientFactory;

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
    ).resolves.toEqual([
      {
        id: "event_1",
        calendarId: "primary",
        title: "Planning",
        start: "2026-05-07T09:00:00-07:00",
        end: "2026-05-07T09:30:00-07:00",
        htmlLink: undefined,
        meetLink: undefined,
        attendees: undefined,
        location: undefined,
        description: undefined,
      },
    ]);
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
      requestBody: { summary: "Updated Planning" },
    });
    expect(fakeCalendar.events.delete).toHaveBeenCalledWith({
      calendarId: "primary",
      eventId: "event_1",
    });
    expect(fakeDrive.files.list).toHaveBeenCalledWith({
      q: "name contains 'Plan'",
      pageSize: 1,
      orderBy: "modifiedTime desc",
      fields: "files(id,name,mimeType,createdTime,webViewLink,modifiedTime,size,parents)",
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
      ["calendar.write"],
      "calendar.updateEvent"
    );
    expect(factory.calendar).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ accountId: "acct_google_1" }),
      ["calendar.write"],
      "calendar.deleteEvent"
    );
    expect(factory.drive).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ accountId: "acct_google_1" }),
      ["drive.read"],
      "drive.searchFiles"
    );
    expect(factory.drive).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ accountId: "acct_google_1" }),
      ["drive.read"],
      "drive.getFile"
    );
    expect(factory.meet).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acct_google_1" }),
      ["meet.create"],
      "meet.createMeeting"
    );
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

function createUnsignedJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "sig",
  ].join(".");
}

function createOAuthCallbackManager(
  provider: string,
  durableAccountId: string,
  setCredentialRef: ReturnType<typeof vi.fn>
) {
  return {
    getStorage: () => ({
      setConnectorAccountCredentialRef: setCredentialRef,
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
