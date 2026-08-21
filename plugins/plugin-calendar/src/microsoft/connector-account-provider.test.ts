/**
 * Deterministic contract coverage for Microsoft account OAuth, durable secret
 * references, identity validation, and plugin registration. Network responses
 * are locally signed/stubbed; this file is not live Microsoft evidence.
 */

import { generateKeyPairSync, sign as signPayload } from "node:crypto";
import {
  ConnectorAccountManager,
  ElizaError,
  getConnectorAccountManager,
  type IAgentRuntime,
  InMemoryConnectorAccountStorage,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calendarPlugin } from "../plugin.js";
import { createMicrosoftConnectorAccountProvider } from "./connector-account-provider.js";

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MICROSOFT_CLIENT_ID = "microsoft-calendar-client";
const MICROSOFT_REDIRECT_URI =
  "http://localhost:3000/api/connectors/microsoft/oauth/callback";
const TENANT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OBJECT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const KEY_ID = "microsoft-test-signing-key";
const { publicKey: testPublicKey, privateKey: testPrivateKey } =
  generateKeyPairSync("rsa", { modulusLength: 2048 });
const exportedJwk = testPublicKey.export({ format: "jwk" });

interface StoredCredentialRef {
  accountId: string;
  credentialType: string;
  vaultRef: string;
  metadata?: Record<string, unknown>;
  expiresAt?: number;
}

interface Harness {
  runtime: IAgentRuntime;
  manager: ConnectorAccountManager;
  storage: InMemoryConnectorAccountStorage;
  vault: Map<string, string>;
  refs: StoredCredentialRef[];
  fetchMock: ReturnType<typeof vi.fn>;
  setReturnedNonce(value: string): void;
}

function unsignedFlow(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: "oauth-flow",
    provider: "microsoft",
    state: "oauth-state",
    status: "pending" as const,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function signedIdToken(nonce: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: KEY_ID, typ: "JWT" }),
  ).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      aud: MICROSOFT_CLIENT_ID,
      iss: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
      tid: TENANT_ID,
      nonce,
      sub: "subject-1",
      oid: OBJECT_ID,
      iat: now,
      nbf: now - 5,
      exp: now + 3_600,
    }),
  ).toString("base64url");
  const input = `${header}.${claims}`;
  const signature = signPayload(
    "RSA-SHA256",
    Buffer.from(input),
    testPrivateKey,
  ).toString("base64url");
  return `${input}.${signature}`;
}

function settings(key: string): string | null {
  return (
    {
      MICROSOFT_CLIENT_ID,
      MICROSOFT_REDIRECT_URI,
      MICROSOFT_TENANT_ID: "common",
    }[key] ?? null
  );
}

function createHarness(
  options: { secretBackend?: boolean; returnedScope?: string } = {},
): Harness {
  const storage = new InMemoryConnectorAccountStorage();
  const vault = new Map<string, string>();
  const refs: StoredCredentialRef[] = [];
  let returnedNonce = "";
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/common/oauth2/v2.0/token")) {
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("client_id")).toBe(MICROSOFT_CLIENT_ID);
        expect(form.get("code")).toBe("authorization-code");
        expect(form.get("grant_type")).toBe("authorization_code");
        expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/u);
        expect(form.get("client_secret")).toBeNull();
        return Response.json({
          access_token: "microsoft-access-token",
          refresh_token: "microsoft-refresh-token",
          id_token: signedIdToken(returnedNonce),
          token_type: "Bearer",
          expires_in: 3_600,
          scope:
            options.returnedScope ??
            "openid profile email User.Read Calendars.Read",
        });
      }
      if (
        url === "https://login.microsoftonline.com/common/discovery/v2.0/keys"
      ) {
        return Response.json({
          keys: [
            {
              kid: KEY_ID,
              kty: exportedJwk.kty,
              n: exportedJwk.n,
              e: exportedJwk.e,
              alg: "RS256",
              use: "sig",
            },
          ],
        });
      }
      if (url.startsWith("https://graph.microsoft.com/v1.0/me?")) {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer microsoft-access-token",
        );
        return Response.json({
          id: OBJECT_ID,
          displayName: "Ada Parent",
          mail: "Ada.Parent@example.com",
          userPrincipalName: "ada@example.onmicrosoft.com",
          userType: "Member",
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  );
  const vaultService = {
    set: async (key: string, value: string) => {
      vault.set(key, value);
    },
    remove: async (key: string) => {
      vault.delete(key);
    },
  };
  const runtime = {
    agentId: AGENT_ID,
    fetch: fetchMock,
    getSetting: settings,
    getService: (serviceType: string) =>
      options.secretBackend === false
        ? null
        : serviceType === "vault"
          ? vaultService
          : null,
    setConnectorAccountCredentialRef: async (ref: StoredCredentialRef) => {
      const pending = await storage.getAccount("microsoft", ref.accountId);
      expect(pending?.status).toBe("pending");
      refs.push({ ...ref });
      return ref;
    },
    listConnectorAccountCredentialRefs: async ({
      accountId,
    }: {
      accountId: string;
    }) => refs.filter((ref) => ref.accountId === accountId),
  } as unknown as IAgentRuntime;
  const manager = new ConnectorAccountManager(runtime, storage);
  manager.registerProvider(createMicrosoftConnectorAccountProvider(runtime));
  return {
    runtime,
    manager,
    storage,
    vault,
    refs,
    fetchMock,
    setReturnedNonce(value: string) {
      returnedNonce = value;
    },
  };
}

async function startReadFlow(harness: Harness) {
  const flow = await harness.manager.startOAuth("microsoft", {
    scopes: ["microsoft.calendar.read"],
    metadata: { requestedRole: "OWNER" },
  });
  const metadata = flow.metadata as Record<string, unknown>;
  harness.setReturnedNonce(String(metadata.nonce));
  return flow;
}

describe("Microsoft connector account provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["microsoft.calendar.read_basic", "Calendars.ReadBasic"],
    ["microsoft.calendar.freebusy", "Calendars.ReadBasic"],
    ["microsoft.calendar.read", "Calendars.Read"],
    ["Calendars.Read", "Calendars.Read"],
    ["microsoft.calendar.write", "Calendars.ReadWrite"],
  ])(
    "requests only baseline identity and the least calendar scope for %s",
    async (capability, expectedCalendarScope) => {
      const harness = createHarness();
      const provider = createMicrosoftConnectorAccountProvider(harness.runtime);
      const started = await provider.startOAuth?.(
        {
          provider: "microsoft",
          flow: unsignedFlow(),
          scopes: [capability],
        },
        harness.manager,
      );
      const url = new URL(started?.authUrl ?? "");
      const scopes = new Set(
        (url.searchParams.get("scope") ?? "").split(" ").filter(Boolean),
      );

      expect(scopes).toEqual(
        new Set([
          "openid",
          "profile",
          "email",
          "offline_access",
          "User.Read",
          expectedCalendarScope,
        ]),
      );
      expect(
        [...scopes].filter((scope) => scope.startsWith("Calendars.")),
      ).toEqual([expectedCalendarScope]);
      expect(url.searchParams.get("state")).toBe("oauth-state");
      expect(url.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]+$/u);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("code_challenge")).toMatch(
        /^[A-Za-z0-9_-]+$/u,
      );
      expect(started?.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/u);
      expect(started?.metadata).not.toHaveProperty("codeVerifier");
    },
  );

  it("fails closed for unknown capabilities and identity-only requests", async () => {
    const harness = createHarness();
    const provider = createMicrosoftConnectorAccountProvider(harness.runtime);

    await expect(
      provider.startOAuth?.(
        {
          provider: "microsoft",
          flow: unsignedFlow(),
          scopes: ["Files.ReadWrite.All"],
        },
        harness.manager,
      ),
    ).rejects.toMatchObject({
      code: "MICROSOFT_OAUTH_SCOPE_UNRECOGNIZED",
    });
    await expect(
      provider.startOAuth?.(
        {
          provider: "microsoft",
          flow: unsignedFlow(),
          scopes: ["openid", "profile", "User.Read"],
        },
        harness.manager,
      ),
    ).rejects.toMatchObject({
      code: "MICROSOFT_OAUTH_CALENDAR_CAPABILITY_REQUIRED",
    });
  });

  it("rejects broader calendar grants than the exact requested privilege", async () => {
    const harness = createHarness({
      returnedScope:
        "openid profile email User.Read Calendars.Read Calendars.ReadWrite",
    });
    const flow = await startReadFlow(harness);

    await expect(
      harness.manager.completeOAuth("microsoft", {
        state: flow.state,
        code: "authorization-code",
        query: { state: flow.state },
      }),
    ).rejects.toMatchObject({
      // The account manager persists a terminal failed flow and rethrows the
      // typed wrapper (error-policy J2); the provider-specific code stays on
      // the cause chain.
      code: "CONNECTOR_OAUTH_COMPLETION_FAILED",
      cause: expect.objectContaining({
        code: "MICROSOFT_OAUTH_SCOPE_ESCALATION",
      }),
    });
    expect(await harness.storage.listAccounts("microsoft")).toEqual([]);
    expect(harness.vault.size).toBe(0);
  });

  it.each([
    {
      name: "non-JSON token response",
      response: () =>
        new Response("<html>not a token response</html>", {
          headers: { "content-type": "text/html" },
        }),
    },
    {
      name: "oversized token response",
      response: () =>
        new Response(JSON.stringify({ padding: "x".repeat(1_048_576) }), {
          headers: { "content-type": "application/json" },
        }),
    },
  ])(
    "rejects a $name before identity discovery or secret persistence",
    async ({ response }) => {
      const harness = createHarness();
      const flow = await startReadFlow(harness);
      harness.fetchMock.mockImplementationOnce(async () => response());

      await expect(
        harness.manager.completeOAuth("microsoft", {
          state: flow.state,
          code: "authorization-code",
          query: { state: flow.state },
        }),
      ).rejects.toMatchObject({
        // The account manager persists a terminal failed flow and rethrows the
        // typed wrapper (error-policy J2); the provider-specific code stays on
        // the cause chain.
        code: "CONNECTOR_OAUTH_COMPLETION_FAILED",
        cause: expect.objectContaining({
          code: "MICROSOFT_OAUTH_TOKEN_RESPONSE_INVALID",
        }),
      });
      expect(await harness.storage.listAccounts("microsoft")).toEqual([]);
      expect(harness.vault.size).toBe(0);
    },
  );

  it("does not allow account CRUD to bypass OAuth completion", async () => {
    const harness = createHarness();

    await expect(
      harness.manager.createAccount("microsoft", {
        status: "connected",
        metadata: { ACCESS_TOKEN: "must-not-persist" },
      }),
    ).rejects.toMatchObject({
      code: "MICROSOFT_PLAINTEXT_CREDENTIAL_REJECTED",
    });
    await expect(
      harness.manager.createAccount("microsoft", {
        status: "connected",
      }),
    ).rejects.toMatchObject({ code: "MICROSOFT_OAUTH_REQUIRED" });
    const pending = await harness.manager.createAccount("microsoft", {
      status: "pending",
    });
    await expect(
      harness.manager.patchAccount("microsoft", pending.id, {
        status: "connected",
      }),
    ).rejects.toMatchObject({ code: "MICROSOFT_OAUTH_REQUIRED" });
    expect(
      await harness.storage.getAccount("microsoft", pending.id),
    ).toMatchObject({ status: "pending" });
  });

  it("keeps the manager flow pending and rejects an unknown callback state", async () => {
    const harness = createHarness();
    const flow = await startReadFlow(harness);

    expect(flow.status).toBe("pending");
    expect(await harness.storage.listAccounts("microsoft")).toEqual([]);
    await expect(
      harness.manager.completeOAuth("microsoft", {
        state: "not-the-issued-state",
        code: "authorization-code",
      }),
    ).rejects.toThrow("Unknown, expired, or already used OAuth flow state");
    expect(harness.fetchMock).not.toHaveBeenCalled();
  });

  it("rejects mismatched callback state and missing callback code before exchange", async () => {
    const harness = createHarness();
    const provider = createMicrosoftConnectorAccountProvider(harness.runtime);
    const flow = unsignedFlow({
      codeVerifier: "valid-code-verifier",
      metadata: {
        nonce: "issued-nonce",
        requestedCapabilities: ["microsoft.calendar.read"],
        redirectUri: MICROSOFT_REDIRECT_URI,
      },
    });

    await expect(
      provider.completeOAuth?.(
        {
          provider: "microsoft",
          flow,
          code: "authorization-code",
          query: { state: "wrong-state" },
        },
        harness.manager,
      ),
    ).rejects.toMatchObject({ code: "MICROSOFT_OAUTH_STATE_MISMATCH" });
    await expect(
      provider.completeOAuth?.(
        {
          provider: "microsoft",
          flow,
          query: { state: "oauth-state" },
        },
        harness.manager,
      ),
    ).rejects.toMatchObject({ code: "MICROSOFT_OAUTH_CODE_MISSING" });
    expect(harness.fetchMock).not.toHaveBeenCalled();
  });

  it("persists token material only in a durable secret and connects after its reference commits", async () => {
    const harness = createHarness();
    const flow = await startReadFlow(harness);
    const result = await harness.manager.completeOAuth("microsoft", {
      state: flow.state,
      code: "authorization-code",
      query: { state: flow.state },
    });

    expect(result.flow.status).toBe("completed");
    expect(result.account).toMatchObject({
      provider: "microsoft",
      role: "OWNER",
      purpose: ["calendar"],
      status: "connected",
      externalId: `${TENANT_ID}:${OBJECT_ID}`,
      displayHandle: "ada.parent@example.com",
    });
    expect(result.account?.metadata).toMatchObject({
      email: "ada.parent@example.com",
      tenantId: TENANT_ID,
      accountKind: "organization",
      grantedScopes: [
        "openid",
        "profile",
        "email",
        "User.Read",
        "Calendars.Read",
      ],
      hasRefreshToken: true,
      credentialRefs: [
        expect.objectContaining({
          credentialType: "oauth.tokens",
          vaultRef: expect.stringMatching(
            /^connector\/microsoft\/[a-f0-9]+\/[a-f0-9]+\/oauth_tokens$/u,
          ),
        }),
      ],
    });
    expect(harness.refs).toEqual([
      expect.objectContaining({
        accountId: result.account?.id,
        credentialType: "oauth.tokens",
        vaultRef: expect.stringMatching(
          /^connector\/microsoft\/[a-f0-9]+\/[a-f0-9]+\/oauth_tokens$/u,
        ),
      }),
    ]);
    const storedSecret = [...harness.vault.values()][0];
    expect(storedSecret).toContain("microsoft-access-token");
    expect(storedSecret).toContain("microsoft-refresh-token");
    const publicArtifacts = JSON.stringify({
      account: result.account,
      flow: result.flow,
      refs: harness.refs,
    });
    expect(publicArtifacts).not.toContain("microsoft-access-token");
    expect(publicArtifacts).not.toContain("microsoft-refresh-token");
    expect(publicArtifacts).not.toContain("authorization-code");
    expect(publicArtifacts).not.toContain("id_token");
    expect(
      harness.fetchMock.mock.calls.every(
        (call) => (call[1] as RequestInit | undefined)?.redirect === "error",
      ),
    ).toBe(true);
  });

  it("verifies the signed nonce binding before discovering or persisting an account", async () => {
    const harness = createHarness();
    const flow = await startReadFlow(harness);
    harness.setReturnedNonce("different-nonce");

    await expect(
      harness.manager.completeOAuth("microsoft", {
        state: flow.state,
        code: "authorization-code",
        query: { state: flow.state },
      }),
    ).rejects.toMatchObject({
      // The account manager persists a terminal failed flow and rethrows the
      // typed wrapper (error-policy J2); the provider-specific code stays on
      // the cause chain.
      code: "CONNECTOR_OAUTH_COMPLETION_FAILED",
      cause: expect.objectContaining({
        code: "MICROSOFT_OAUTH_NONCE_MISMATCH",
      }),
    });
    expect(await harness.storage.listAccounts("microsoft")).toEqual([]);
    expect(harness.refs).toEqual([]);
    expect(harness.vault.size).toBe(0);
    expect(
      harness.fetchMock.mock.calls.some(([input]) =>
        String(input).startsWith("https://graph.microsoft.com/v1.0/me?"),
      ),
    ).toBe(false);
  });

  it("refuses to bind a reconnect flow to a different Microsoft identity", async () => {
    const harness = createHarness();
    const existing = await harness.manager.upsertAccount("microsoft", {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      provider: "microsoft",
      role: "OWNER",
      purpose: ["calendar"],
      accessGate: "open",
      status: "revoked",
      externalId: `${TENANT_ID}:different-object-id`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const flow = await harness.manager.startOAuth("microsoft", {
      accountId: existing.id,
      scopes: ["microsoft.calendar.read"],
    });
    harness.setReturnedNonce(String(flow.metadata?.nonce));

    await expect(
      harness.manager.completeOAuth("microsoft", {
        state: flow.state,
        code: "authorization-code",
        query: { state: flow.state },
      }),
    ).rejects.toMatchObject({
      // The account manager persists a terminal failed flow and rethrows the
      // typed wrapper (error-policy J2); the provider-specific code stays on
      // the cause chain.
      code: "CONNECTOR_OAUTH_COMPLETION_FAILED",
      cause: expect.objectContaining({
        code: "MICROSOFT_OAUTH_ACCOUNT_IDENTITY_MISMATCH",
      }),
    });
    expect(harness.vault.size).toBe(0);
    expect(harness.refs).toEqual([]);
    expect(
      await harness.storage.getAccount("microsoft", existing.id),
    ).toMatchObject({ status: "revoked" });
  });

  it("leaves an account pending when no durable secret backend is registered", async () => {
    const harness = createHarness({ secretBackend: false });
    const flow = await startReadFlow(harness);

    await expect(
      harness.manager.completeOAuth("microsoft", {
        state: flow.state,
        code: "authorization-code",
        query: { state: flow.state },
      }),
    ).rejects.toMatchObject({
      // The account manager persists a terminal failed flow and rethrows the
      // typed wrapper (error-policy J2); the provider-specific code stays on
      // the cause chain.
      code: "CONNECTOR_OAUTH_COMPLETION_FAILED",
      cause: expect.objectContaining({
        code: "MICROSOFT_SECRET_WRITER_UNAVAILABLE",
      }),
    });
    const accounts = await harness.storage.listAccounts("microsoft");
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.status).toBe("pending");
    expect(harness.refs).toEqual([]);
  });

  it("removes local credentials without claiming remote revocation", async () => {
    const harness = createHarness();
    const flow = await startReadFlow(harness);
    const connected = await harness.manager.completeOAuth("microsoft", {
      state: flow.state,
      code: "authorization-code",
      query: { state: flow.state },
    });
    const fetchCallsBeforeDisconnect = harness.fetchMock.mock.calls.length;

    const revoked = await harness.manager.patchAccount(
      "microsoft",
      connected.account?.id ?? "",
      { status: "revoked" },
    );

    expect(revoked?.status).toBe("revoked");
    expect(revoked?.metadata).not.toHaveProperty("credentialRefs");
    expect(revoked?.metadata).toMatchObject({
      disconnect: {
        localSecretsCleared: 1,
        remoteRevocation: "not_attempted",
      },
    });
    expect(harness.vault.size).toBe(0);
    expect(harness.fetchMock).toHaveBeenCalledTimes(fetchCallsBeforeDisconnect);
  });

  it("registers the Microsoft provider during calendar plugin initialization", async () => {
    const runtime = {
      agentId: AGENT_ID,
      getService: () => null,
      getSetting: () => null,
    } as unknown as IAgentRuntime;

    await calendarPlugin.init?.({}, runtime);

    expect(
      getConnectorAccountManager(runtime).getProvider("microsoft"),
    ).toEqual(
      expect.objectContaining({
        provider: "microsoft",
        startOAuth: expect.any(Function),
        completeOAuth: expect.any(Function),
      }),
    );
  });

  it("uses structured errors for callback contract failures", async () => {
    const harness = createHarness();
    const provider = createMicrosoftConnectorAccountProvider(harness.runtime);

    await expect(
      provider.completeOAuth?.(
        {
          provider: "microsoft",
          flow: unsignedFlow(),
          query: {},
        },
        harness.manager,
      ),
    ).rejects.toBeInstanceOf(ElizaError);
  });
});

async function startFlowWith(harness: Harness, scopes: string[]) {
  const flow = await harness.manager.startOAuth("microsoft", {
    scopes,
    metadata: { requestedRole: "OWNER" },
  });
  const metadata = flow.metadata as Record<string, unknown>;
  harness.setReturnedNonce(String(metadata.nonce));
  return flow;
}

describe("Microsoft Graph multi-domain incremental scopes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["microsoft.mail.triage", ["Mail.Read"]],
    ["Mail.Read", ["Mail.Read"]],
    ["microsoft.mail.manage", ["Mail.ReadWrite"]],
    ["microsoft.mail.send", ["Mail.Send"]],
    ["microsoft.contacts.read", ["Contacts.Read"]],
    ["Contacts.Read", ["Contacts.Read"]],
    ["microsoft.files.read", ["Files.Read"]],
  ] as const)(
    "requests identity plus only the %s permission and never a calendar scope",
    async (capability, expectedScopes) => {
      const harness = createHarness();
      const provider = createMicrosoftConnectorAccountProvider(harness.runtime);
      const started = await provider.startOAuth?.(
        {
          provider: "microsoft",
          flow: unsignedFlow(),
          scopes: [capability],
        },
        harness.manager,
      );
      const url = new URL(started?.authUrl ?? "");
      const scopes = new Set(
        (url.searchParams.get("scope") ?? "").split(" ").filter(Boolean),
      );

      expect(scopes).toEqual(
        new Set([
          "openid",
          "profile",
          "email",
          "offline_access",
          "User.Read",
          ...expectedScopes,
        ]),
      );
      expect([...scopes].some((scope) => scope.startsWith("Calendars."))).toBe(
        false,
      );
    },
  );

  it("composes one consent request across calendar, mail, contacts, and files", async () => {
    const harness = createHarness();
    const provider = createMicrosoftConnectorAccountProvider(harness.runtime);
    const started = await provider.startOAuth?.(
      {
        provider: "microsoft",
        flow: unsignedFlow(),
        scopes: [
          "microsoft.calendar.read",
          "microsoft.mail.manage",
          "microsoft.mail.send",
          "microsoft.contacts.read",
          "microsoft.files.read",
        ],
      },
      harness.manager,
    );
    const scopes = new Set(
      (new URL(started?.authUrl ?? "").searchParams.get("scope") ?? "")
        .split(" ")
        .filter(Boolean),
    );

    expect(scopes).toEqual(
      new Set([
        "openid",
        "profile",
        "email",
        "offline_access",
        "User.Read",
        "Calendars.Read",
        "Mail.ReadWrite",
        "Mail.Send",
        "Contacts.Read",
        "Files.Read",
      ]),
    );
  });

  it("still rejects scopes outside the supported Graph capability catalog", async () => {
    const harness = createHarness();
    const provider = createMicrosoftConnectorAccountProvider(harness.runtime);

    for (const scope of ["Files.ReadWrite.All", "Mail.ReadWrite.Shared"]) {
      await expect(
        provider.startOAuth?.(
          {
            provider: "microsoft",
            flow: unsignedFlow(),
            scopes: [scope],
          },
          harness.manager,
        ),
      ).rejects.toMatchObject({ code: "MICROSOFT_OAUTH_SCOPE_UNRECOGNIZED" });
    }
  });

  it("rejects a broader mail grant than the requested triage privilege", async () => {
    const harness = createHarness({
      returnedScope: "openid profile email User.Read Mail.ReadWrite",
    });
    const flow = await startFlowWith(harness, ["microsoft.mail.triage"]);

    await expect(
      harness.manager.completeOAuth("microsoft", {
        state: flow.state,
        code: "authorization-code",
        query: { state: flow.state },
      }),
    ).rejects.toMatchObject({
      code: "CONNECTOR_OAUTH_COMPLETION_FAILED",
      cause: expect.objectContaining({
        code: "MICROSOFT_OAUTH_SCOPE_ESCALATION",
      }),
    });
    expect(await harness.storage.listAccounts("microsoft")).toEqual([]);
    expect(harness.vault.size).toBe(0);
  });

  it("rejects an unrequested cross-domain grant on a calendar-only flow", async () => {
    const harness = createHarness({
      returnedScope:
        "openid profile email User.Read Calendars.Read Contacts.Read",
    });
    const flow = await startFlowWith(harness, ["microsoft.calendar.read"]);

    await expect(
      harness.manager.completeOAuth("microsoft", {
        state: flow.state,
        code: "authorization-code",
        query: { state: flow.state },
      }),
    ).rejects.toMatchObject({
      code: "CONNECTOR_OAUTH_COMPLETION_FAILED",
      cause: expect.objectContaining({
        code: "MICROSOFT_OAUTH_SCOPE_ESCALATION",
      }),
    });
    expect(harness.vault.size).toBe(0);
  });

  it("rejects a completion whose token grant dropped a requested domain", async () => {
    const harness = createHarness({
      returnedScope: "openid profile email User.Read Mail.Read",
    });
    const flow = await startFlowWith(harness, [
      "microsoft.mail.triage",
      "microsoft.contacts.read",
    ]);

    await expect(
      harness.manager.completeOAuth("microsoft", {
        state: flow.state,
        code: "authorization-code",
        query: { state: flow.state },
      }),
    ).rejects.toMatchObject({
      code: "CONNECTOR_OAUTH_COMPLETION_FAILED",
      cause: expect.objectContaining({
        code: "MICROSOFT_OAUTH_GRANTED_SCOPE_MISSING",
      }),
    });
    expect(harness.vault.size).toBe(0);
  });

  it("connects a mail-only account without any calendar grant", async () => {
    const harness = createHarness({
      returnedScope: "openid profile email User.Read Mail.Read Mail.Send",
    });
    const flow = await startFlowWith(harness, [
      "microsoft.mail.triage",
      "microsoft.mail.send",
    ]);
    const result = await harness.manager.completeOAuth("microsoft", {
      state: flow.state,
      code: "authorization-code",
      query: { state: flow.state },
    });

    expect(result.flow.status).toBe("completed");
    expect(result.account).toMatchObject({
      provider: "microsoft",
      status: "connected",
      externalId: `${TENANT_ID}:${OBJECT_ID}`,
    });
    expect(result.account?.metadata).toMatchObject({
      grantedScopes: [
        "openid",
        "profile",
        "email",
        "User.Read",
        "Mail.Read",
        "Mail.Send",
      ],
      hasRefreshToken: true,
    });
    expect(harness.vault.size).toBe(1);
    const secret = JSON.parse([...harness.vault.values()][0] ?? "{}");
    expect(secret.scope).toBe(
      "openid profile email User.Read Mail.Read Mail.Send",
    );
  });
});
