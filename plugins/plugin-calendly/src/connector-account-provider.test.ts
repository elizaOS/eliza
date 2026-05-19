import {
  type ConnectorAccount,
  type ConnectorAccountPatch,
  getConnectorAccountManager,
  type IAgentRuntime,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CALENDLY_PROVIDER_NAME,
  createCalendlyConnectorAccountProvider,
} from "./connector-account-provider.js";

type RuntimeSetting = string | number | boolean | null;

interface TestRuntimeShape {
  agentId?: string;
  character?: unknown;
  getSetting?: (key: string) => RuntimeSetting;
  getService?: (serviceType: string) => unknown;
}

function toRuntimeSetting(value: unknown): RuntimeSetting {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? value
    : null;
}

function createTestRuntime(runtimeShape: TestRuntimeShape): IAgentRuntime {
  return Object.assign(Object.create(null) as IAgentRuntime, runtimeShape);
}

function runtime(settings: Record<string, unknown>): IAgentRuntime {
  return createTestRuntime({
    character: {},
    getSetting: vi.fn((key: string) => toRuntimeSetting(settings[key])),
  });
}

describe("Calendly ConnectorAccountManager provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("lists legacy access tokens as a default OWNER account", async () => {
    const rt = runtime({ CALENDLY_ACCESS_TOKEN: "calendly-token" });
    const manager = getConnectorAccountManager(rt);
    manager.registerProvider(createCalendlyConnectorAccountProvider(rt));

    const accounts = await manager.listAccounts(CALENDLY_PROVIDER_NAME);

    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      id: "default",
      provider: CALENDLY_PROVIDER_NAME,
      role: "OWNER",
      accessGate: "open",
      status: "connected",
      metadata: expect.objectContaining({
        authMethod: "personal_access_token",
        isDefault: true,
      }),
    });
    expect(accounts[0]?.purpose).toEqual(
      expect.arrayContaining(["admin", "automation"]),
    );
  });

  it("creates, patches, and deletes stored accounts without hiding legacy default", async () => {
    const rt = runtime({ CALENDLY_ACCESS_TOKEN: "calendly-token" });
    const manager = getConnectorAccountManager(rt);
    manager.registerProvider(createCalendlyConnectorAccountProvider(rt));

    const created = await manager.createAccount(CALENDLY_PROVIDER_NAME, {
      label: "Agent Calendly",
      role: "AGENT",
      purpose: ["automation"],
      status: "connected",
    });

    expect(created).toMatchObject({
      provider: CALENDLY_PROVIDER_NAME,
      label: "Agent Calendly",
      role: "AGENT",
      purpose: ["automation"],
      status: "connected",
    });

    const listed = await manager.listAccounts(CALENDLY_PROVIDER_NAME);
    expect(listed.map((account) => account.id)).toEqual(
      expect.arrayContaining([created.id, "default"]),
    );

    const patched = await manager.patchAccount(
      CALENDLY_PROVIDER_NAME,
      created.id,
      {
        label: "Renamed Calendly",
        displayHandle: "agent-calendly",
      },
    );
    expect(patched).toMatchObject({
      id: created.id,
      label: "Renamed Calendly",
      displayHandle: "agent-calendly",
      role: "AGENT",
      purpose: ["automation"],
    });

    await expect(
      manager.deleteAccount(CALENDLY_PROVIDER_NAME, created.id),
    ).resolves.toBe(true);
    await expect(
      manager.getAccount(CALENDLY_PROVIDER_NAME, created.id),
    ).resolves.toBeNull();
  });

  it("persists callback tokens as credential refs without returning token metadata", async () => {
    const vault = new Map<string, string>();
    const setCredentialRef = vi.fn(async () => undefined);
    const rt = createTestRuntime({
      agentId: "agent-1",
      character: {},
      getSetting: vi.fn(
        (key: string) =>
          ({
            CALENDLY_OAUTH_CLIENT_ID: "calendly-client",
            CALENDLY_OAUTH_CLIENT_SECRET: "calendly-secret",
            CALENDLY_OAUTH_REDIRECT_URI:
              "http://localhost/oauth/calendly/callback",
          })[key] ?? null,
      ),
      getService: (serviceType: string) =>
        serviceType === "vault"
          ? {
              set: async (key: string, value: string) => {
                vault.set(key, value);
              },
            }
          : null,
    });
    const manager = createOAuthCallbackManager(
      CALENDLY_PROVIDER_NAME,
      "acct_calendly_durable_1",
      setCredentialRef,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const href = String(url);
        if (href.includes("auth.calendly.com/oauth/token")) {
          return new Response(
            JSON.stringify({
              access_token: "calendly-access-token",
              refresh_token: "calendly-refresh-token",
              expires_in: 7200,
              token_type: "bearer",
              scope: "default",
              owner: "https://api.calendly.com/users/user-1",
              organization: "https://api.calendly.com/organizations/org-1",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (href.includes("api.calendly.com/users/me")) {
          return new Response(
            JSON.stringify({
              resource: {
                uri: "https://api.calendly.com/users/user-1",
                name: "Ada Lovelace",
                email: "ada@example.com",
                scheduling_url: "https://calendly.com/ada",
                timezone: "America/Los_Angeles",
                current_organization:
                  "https://api.calendly.com/organizations/org-1",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected fetch ${href}`);
      }),
    );

    const provider = createCalendlyConnectorAccountProvider(rt);
    const result = await provider.completeOAuth?.(
      {
        provider: CALENDLY_PROVIDER_NAME,
        code: "oauth-code",
        query: {},
        flow: {
          id: "flow-1",
          provider: CALENDLY_PROVIDER_NAME,
          state: "state-1",
          status: "pending",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
      manager as never,
    );

    const account = result?.account as ConnectorAccount;
    const metadata = account.metadata as Record<string, unknown>;
    expect(account.id).toBe("acct_calendly_durable_1");
    expect(JSON.stringify(metadata)).not.toContain("calendly-access-token");
    expect(JSON.stringify(metadata)).not.toContain("calendly-refresh-token");
    expect(metadata.credentialRefs).toEqual([
      expect.objectContaining({
        credentialType: "oauth.tokens",
        vaultRef:
          "connector.agent-1.calendly.acct_calendly_durable_1.oauth_tokens",
      }),
    ]);
    expect(
      vault.get(
        "connector.agent-1.calendly.acct_calendly_durable_1.oauth_tokens",
      ),
    ).toContain("calendly-access-token");
    expect(
      vault.get(
        "connector.agent-1.calendly.acct_calendly_durable_1.oauth_tokens",
      ),
    ).toContain("calendly-refresh-token");
    expect(setCredentialRef).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct_calendly_durable_1",
        credentialType: "oauth.tokens",
        vaultRef:
          "connector.agent-1.calendly.acct_calendly_durable_1.oauth_tokens",
      }),
    );
  });

  it("fails OAuth callback when no durable vault writer is available", async () => {
    const rt = createTestRuntime({
      agentId: "agent-1",
      character: {},
      getSetting: vi.fn(
        (key: string) =>
          ({
            CALENDLY_OAUTH_CLIENT_ID: "calendly-client",
            CALENDLY_OAUTH_CLIENT_SECRET: "calendly-secret",
            CALENDLY_OAUTH_REDIRECT_URI:
              "http://localhost/oauth/calendly/callback",
          })[key] ?? null,
      ),
      getService: () => null,
    });
    const manager = createOAuthCallbackManager(
      CALENDLY_PROVIDER_NAME,
      "acct_calendly_durable_1",
      vi.fn(async () => undefined),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const href = String(url);
        if (href.includes("auth.calendly.com/oauth/token")) {
          return new Response(
            JSON.stringify({
              access_token: "calendly-access-token",
              refresh_token: "calendly-refresh-token",
              expires_in: 7200,
              token_type: "bearer",
              scope: "default",
              owner: "https://api.calendly.com/users/user-1",
              organization: "https://api.calendly.com/organizations/org-1",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (href.includes("api.calendly.com/users/me")) {
          return new Response(
            JSON.stringify({
              resource: {
                uri: "https://api.calendly.com/users/user-1",
                name: "Ada Lovelace",
                email: "ada@example.com",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected fetch ${href}`);
      }),
    );

    const provider = createCalendlyConnectorAccountProvider(rt);
    await expect(
      provider.completeOAuth?.(
        {
          provider: CALENDLY_PROVIDER_NAME,
          code: "oauth-code",
          query: {},
          flow: {
            id: "flow-1",
            provider: CALENDLY_PROVIDER_NAME,
            state: "state-1",
            status: "pending",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
        manager as never,
      ),
    ).rejects.toThrow(/durable connector credential store|vault writer/i);
  });
});

function createOAuthCallbackManager(
  provider: string,
  durableAccountId: string,
  setCredentialRef: ReturnType<typeof vi.fn>,
) {
  return {
    getStorage: () => ({
      setConnectorAccountCredentialRef: setCredentialRef,
    }),
    upsertAccount: vi.fn(
      async (
        providerId: string,
        input: ConnectorAccountPatch & { provider?: string },
        accountId?: string,
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
      }),
    ),
  };
}
