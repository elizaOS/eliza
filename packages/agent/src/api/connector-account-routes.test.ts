import type { IncomingMessage, ServerResponse } from "node:http";
import type { ReadJsonBodyOptions } from "@elizaos/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const coreMocks = vi.hoisted(() => {
  type TestAccount = {
    id: string;
    provider: string;
    label?: string;
    role?: string;
    purpose?: string[];
    accessGate?: string;
    status?: string;
    createdAt?: number;
    updatedAt?: number;
    metadata?: Record<string, unknown>;
    externalId?: string | null;
    displayHandle?: string | null;
    ownerBindingId?: string | null;
    ownerIdentityId?: string | null;
  };
  type TestFlow = {
    id: string;
    provider: string;
    state: string;
    status: string;
    accountId?: string;
    authUrl?: string;
    error?: string;
    redirectUri?: string;
    createdAt: number;
    updatedAt: number;
    expiresAt?: number;
    metadata?: Record<string, unknown>;
  };
  type TestProvider = {
    provider: string;
    startOAuth?: (request: { flow: TestFlow }) => Promise<{ authUrl: string }>;
    completeOAuth?: (request: {
      flow: TestFlow;
      code?: string;
      error?: string;
      errorDescription?: string;
      query?: Record<string, string | undefined>;
      body?: unknown;
    }) =>
      | Promise<{
          account?: TestAccount;
          flow?: Partial<TestFlow>;
          redirectUrl?: string;
        }>
      | {
          account?: TestAccount;
          flow?: Partial<TestFlow>;
          redirectUrl?: string;
        };
  };

  function key(provider: string, id: string): string {
    return `${provider.toLowerCase()}:${id}`;
  }

  class InMemoryConnectorAccountStorage {
    accounts = new Map<string, TestAccount>();
    flows = new Map<string, TestFlow>();

    async listAccounts(provider?: string) {
      const normalized = provider?.toLowerCase();
      return Array.from(this.accounts.values()).filter(
        (account) => !normalized || account.provider === normalized,
      );
    }

    async getAccount(provider: string, accountId: string) {
      return this.accounts.get(key(provider, accountId)) ?? null;
    }

    async upsertAccount(account: TestAccount) {
      const normalized = {
        ...account,
        provider: account.provider.toLowerCase(),
        role: account.role ?? "OWNER",
        purpose: account.purpose ?? ["messaging"],
        accessGate: account.accessGate ?? "open",
        status: account.status ?? "connected",
        createdAt: account.createdAt ?? Date.now(),
        updatedAt: account.updatedAt ?? Date.now(),
      };
      this.accounts.set(key(normalized.provider, normalized.id), normalized);
      return normalized;
    }

    async deleteAccount(provider: string, accountId: string) {
      return this.accounts.delete(key(provider, accountId));
    }

    async createOAuthFlow(flow: TestFlow) {
      this.flows.set(key(flow.provider, flow.id), flow);
      this.flows.set(key(flow.provider, flow.state), flow);
      return flow;
    }

    async getOAuthFlow(provider: string, flowIdOrState: string) {
      return this.flows.get(key(provider, flowIdOrState)) ?? null;
    }

    async updateOAuthFlow(
      provider: string,
      flowIdOrState: string,
      patch: Partial<TestFlow>,
    ) {
      const existing = this.flows.get(key(provider, flowIdOrState));
      if (!existing) return null;
      const next = { ...existing, ...patch, updatedAt: Date.now() };
      this.flows.set(key(next.provider, next.id), next);
      this.flows.set(key(next.provider, next.state), next);
      return next;
    }

    async deleteOAuthFlow(provider: string, flowIdOrState: string) {
      const existing = this.flows.get(key(provider, flowIdOrState));
      if (!existing) return false;
      this.flows.delete(key(provider, existing.id));
      this.flows.delete(key(provider, existing.state));
      return true;
    }
  }

  class ConnectorAccountManager {
    providers = new Map<string, TestProvider>();

    constructor(private readonly storage: InMemoryConnectorAccountStorage) {}

    registerProvider(provider: TestProvider) {
      this.providers.set(provider.provider.toLowerCase(), {
        ...provider,
        provider: provider.provider.toLowerCase(),
      });
      return {
        provider: provider.provider.toLowerCase(),
        messageConnectorRegistered: false,
        messageConnectorSkipped: false,
        postConnectorRegistered: false,
        postConnectorSkipped: false,
      };
    }

    async listAccounts(provider: string) {
      return this.storage.listAccounts(provider);
    }

    async getAccount(provider: string, accountId: string) {
      return this.storage.getAccount(provider, accountId);
    }

    async createAccount(provider: string, input: Partial<TestAccount>) {
      return this.storage.upsertAccount({
        id: input.id ?? "acct_test",
        provider,
        ...input,
      });
    }

    async patchAccount(
      provider: string,
      accountId: string,
      patch: Partial<TestAccount>,
    ) {
      const existing = await this.storage.getAccount(provider, accountId);
      if (!existing) return null;
      return this.storage.upsertAccount({ ...existing, ...patch });
    }

    async deleteAccount(provider: string, accountId: string) {
      return this.storage.deleteAccount(provider, accountId);
    }

    async startOAuth(
      provider: string,
      input?: { metadata?: Record<string, unknown> },
    ) {
      const normalized = provider.toLowerCase();
      const registered = this.providers.get(normalized);
      if (!registered?.startOAuth) throw new Error("OAuth not supported");
      const now = Date.now();
      const flow: TestFlow = {
        id: `oauth_${now}`,
        provider: normalized,
        state: `state_${now}`,
        status: "pending",
        createdAt: now,
        updatedAt: now,
        metadata: input?.metadata,
      };
      await this.storage.createOAuthFlow(flow);
      const started = await registered.startOAuth({ flow });
      return (
        (await this.storage.updateOAuthFlow(normalized, flow.id, {
          authUrl: started.authUrl,
        })) ?? flow
      );
    }

    async getOAuthFlow(provider: string, flowIdOrState: string) {
      return this.storage.getOAuthFlow(provider, flowIdOrState);
    }

    async completeOAuth(
      provider: string,
      input: {
        state: string;
        code?: string;
        error?: string;
        errorDescription?: string;
        query?: Record<string, string | undefined>;
        body?: unknown;
      },
    ) {
      const normalized = provider.toLowerCase();
      const registered = this.providers.get(normalized);
      if (!registered?.completeOAuth) throw new Error("OAuth not supported");
      const flow = await this.storage.getOAuthFlow(normalized, input.state);
      if (!flow) throw new Error("OAuth flow not found");
      const result = await registered.completeOAuth({
        flow,
        code: input.code,
        error: input.error,
        errorDescription: input.errorDescription,
        query: input.query,
        body: input.body,
      });
      const account = result.account
        ? await this.storage.upsertAccount(result.account)
        : undefined;
      const completed =
        (await this.storage.updateOAuthFlow(normalized, flow.id, {
          ...result.flow,
          status: result.flow?.status ?? "completed",
          accountId: account?.id ?? result.flow?.accountId ?? flow.accountId,
        })) ?? flow;
      return { flow: completed, account, redirectUrl: result.redirectUrl };
    }
  }

  const managers = new WeakMap<object, ConnectorAccountManager>();
  function getConnectorAccountManager(
    runtime?: { getService?: (type: string) => unknown } | null,
    storage?: InMemoryConnectorAccountStorage,
  ) {
    const resolvedStorage =
      storage ??
      (runtime?.getService?.("connector_account_storage") as
        | InMemoryConnectorAccountStorage
        | undefined) ??
      new InMemoryConnectorAccountStorage();
    if (!runtime) return new ConnectorAccountManager(resolvedStorage);
    const existing = managers.get(runtime);
    if (existing) return existing;
    const manager = new ConnectorAccountManager(resolvedStorage);
    managers.set(runtime, manager);
    return manager;
  }

  return {
    DEFAULT_PRIVACY_LEVEL: "owner_only",
    getConnectorAccountManager,
    InMemoryConnectorAccountStorage,
    isPrivacyLevel: (value: unknown) =>
      typeof value === "string" &&
      ["owner_only", "team_visible", "semi_public", "public"].includes(value),
  };
});

vi.mock("@elizaos/core", () => coreMocks);

const { getConnectorAccountManager, InMemoryConnectorAccountStorage } =
  coreMocks;

import {
  type ConnectorAccountRouteContext,
  handleConnectorAccountRoutes,
} from "./connector-account-routes";
import { handleConnectorRoutes } from "./connector-routes";

type Captured = {
  status: number;
  body: unknown;
};

type TestStorage = InstanceType<typeof InMemoryConnectorAccountStorage>;

function createRuntime(storage: TestStorage) {
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    adapter: undefined as unknown,
    getService: vi.fn((type: string) =>
      type === "connector_account_storage" ? storage : null,
    ),
    getMessageConnectors: vi.fn(() => []),
    getPostConnectors: vi.fn(() => []),
    registerMessageConnector: vi.fn(),
    registerPostConnector: vi.fn(),
    logger: {
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    },
  };
}

function createConnectorAccountHarness(options: {
  method: string;
  pathname: string;
  body?: Record<string, unknown>;
  storage?: TestStorage;
  adapter?: unknown;
  authorize?: ConnectorAccountRouteContext["authorize"];
}) {
  const captured: Captured = { status: 200, body: null };
  const storage = options.storage ?? new InMemoryConnectorAccountStorage();
  const runtime = createRuntime(storage);
  runtime.adapter = options.adapter;
  const req = {
    url: options.pathname,
    on: vi.fn(),
  } as unknown as IncomingMessage;
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse;
  const pathname = options.pathname.split("?")[0];
  const ctx: ConnectorAccountRouteContext = {
    req,
    res,
    method: options.method,
    pathname,
    state: { runtime: runtime as never },
    readJsonBody: (async <T extends object>(
      _req: IncomingMessage,
      _res: ServerResponse,
      _options?: ReadJsonBodyOptions,
    ): Promise<T | null> =>
      (options.body ??
        {}) as T) as ConnectorAccountRouteContext["readJsonBody"],
    json: (_res, data, status = 200) => {
      captured.status = status;
      captured.body = data;
    },
    error: (_res, message, status = 500) => {
      captured.status = status;
      captured.body = { error: message };
    },
    authorize: options.authorize,
  };
  return { ctx, captured, runtime, storage };
}

describe("connector account routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles connector account namespace separately from connector config routes", async () => {
    const { ctx, captured, storage } = createConnectorAccountHarness({
      method: "GET",
      pathname: "/api/connectors/slack/accounts",
    });
    await storage.upsertAccount({
      id: "acct_1",
      provider: "slack",
      role: "owner",
      purpose: ["messaging"],
      accessGate: "open",
      status: "connected",
      createdAt: 1,
      updatedAt: 1,
    });

    await expect(handleConnectorAccountRoutes(ctx)).resolves.toBe(true);
    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({
      provider: "slack",
      defaultAccountId: "acct_1",
      accounts: [expect.objectContaining({ id: "acct_1", role: "OWNER" })],
    });

    const configHandled = await handleConnectorRoutes({
      req: ctx.req,
      res: ctx.res,
      method: "DELETE",
      pathname: "/api/connectors/slack/accounts/acct_1",
      state: { config: { connectors: { slack: { enabled: true } } } },
      json: vi.fn(),
      error: vi.fn(),
      readJsonBody: vi.fn(),
      saveElizaConfig: vi.fn(),
      redactConfigSecrets: (value) => value,
      isBlockedObjectKey: (key) =>
        key === "__proto__" || key === "constructor" || key === "prototype",
      cloneWithoutBlockedObjectKeys: (value) => value,
    });
    expect(configHandled).toBe(false);
  });

  it("honors route authorization before connector account reads", async () => {
    const authorize = vi.fn(async () => false);
    const { ctx, captured, storage } = createConnectorAccountHarness({
      method: "GET",
      pathname: "/api/connectors/slack/accounts",
      authorize,
    });
    await storage.upsertAccount({
      id: "acct_1",
      provider: "slack",
      role: "OWNER",
      purpose: ["messaging"],
      accessGate: "open",
      status: "connected",
      createdAt: 1,
      updatedAt: 1,
    });

    await expect(handleConnectorAccountRoutes(ctx)).resolves.toBe(true);

    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "slack",
        namespace: "accounts",
        method: "GET",
      }),
    );
    expect(captured.status).toBe(403);
    expect(captured.body).toEqual({ error: "Forbidden" });
  });

  it("leaves OAuth callbacks available without route authorization", async () => {
    const authorize = vi.fn(async () => false);
    const { ctx, captured, runtime, storage } = createConnectorAccountHarness({
      method: "GET",
      pathname: "/api/connectors/slack/oauth/callback?state=state-1&code=ok",
      authorize,
    });
    const manager = getConnectorAccountManager(runtime as never, storage);
    manager.registerProvider({
      provider: "slack",
      completeOAuth: () => ({
        account: {
          id: "acct_callback",
          provider: "slack",
          label: "Callback account",
          role: "OWNER",
          purpose: ["messaging"],
          accessGate: "open",
          status: "connected",
          createdAt: 1,
          updatedAt: 1,
        },
      }),
    });
    await storage.createOAuthFlow({
      id: "flow-1",
      provider: "slack",
      state: "state-1",
      status: "pending",
      createdAt: 1,
      updatedAt: 1,
      expiresAt: Date.now() + 60_000,
    });

    await expect(handleConnectorAccountRoutes(ctx)).resolves.toBe(true);

    expect(authorize).not.toHaveBeenCalled();
    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({
      ok: true,
      accountId: "acct_callback",
    });
  });

  it("persists OAuth start state through the connector account storage contract", async () => {
    const { ctx, captured, runtime, storage } = createConnectorAccountHarness({
      method: "POST",
      pathname: "/api/connectors/slack/oauth/start",
      body: {
        label: "Work Slack",
        metadata: {
          safeHint: "visible",
          codeVerifier: "pkce-secret",
          nested: { refresh_token: "refresh-secret" },
        },
      },
    });
    const manager = getConnectorAccountManager(runtime as never, storage);
    manager.registerProvider({
      provider: "slack",
      startOAuth: async ({ flow }) => ({
        authUrl: `https://slack.example/oauth?state=${flow.state}`,
      }),
    });

    await expect(handleConnectorAccountRoutes(ctx)).resolves.toBe(true);
    expect(captured.status).toBe(201);
    const startBody = captured.body as {
      flow: {
        id: string;
        state: string;
        authUrl: string;
        metadata?: Record<string, unknown>;
      };
    };
    expect(startBody.flow.authUrl).toContain(startBody.flow.state);
    expect(startBody.flow).toMatchObject({
      metadata: {
        safeHint: "visible",
        nested: {},
      },
    });
    expect(JSON.stringify(startBody.flow)).not.toContain("pkce-secret");
    expect(JSON.stringify(startBody.flow)).not.toContain("refresh-secret");

    const statusHarness = createConnectorAccountHarness({
      method: "GET",
      pathname: `/api/connectors/slack/oauth/status?state=${startBody.flow.state}`,
      storage,
    });
    getConnectorAccountManager(statusHarness.runtime as never, storage);

    await expect(handleConnectorAccountRoutes(statusHarness.ctx)).resolves.toBe(
      true,
    );
    expect(statusHarness.captured.status).toBe(200);
    expect(statusHarness.captured.body).toMatchObject({
      flow: {
        id: startBody.flow.id,
        state: startBody.flow.state,
        status: "pending",
      },
    });
  });

  it("keeps role separate from connector purpose and supports account actions", async () => {
    const { ctx, captured, storage } = createConnectorAccountHarness({
      method: "POST",
      pathname: "/api/connectors/google/accounts",
      body: {
        id: "acct_google",
        label: "Google Owner",
        purpose: "OWNER",
      },
    });

    await expect(handleConnectorAccountRoutes(ctx)).resolves.toBe(true);
    expect(captured.status).toBe(201);
    expect(captured.body).toMatchObject({
      id: "acct_google",
      role: "OWNER",
      purpose: ["messaging"],
    });

    const defaultHarness = createConnectorAccountHarness({
      method: "POST",
      pathname: "/api/connectors/google/accounts/acct_google/default",
      storage,
    });
    await expect(
      handleConnectorAccountRoutes(defaultHarness.ctx),
    ).resolves.toBe(true);
    expect(defaultHarness.captured.body).toMatchObject({
      ok: true,
      defaultAccountId: "acct_google",
      account: expect.objectContaining({ isDefault: true }),
    });

    const testHarness = createConnectorAccountHarness({
      method: "POST",
      pathname: "/api/connectors/google/accounts/acct_google/test",
      storage,
    });
    await expect(handleConnectorAccountRoutes(testHarness.ctx)).resolves.toBe(
      true,
    );
    expect(testHarness.captured.body).toMatchObject({
      ok: true,
      account: expect.objectContaining({ id: "acct_google" }),
    });
  });

  it("normalizes legacy role arrays out of purpose", async () => {
    const { ctx, captured } = createConnectorAccountHarness({
      method: "POST",
      pathname: "/api/connectors/google/accounts",
      body: {
        id: "acct_google_array",
        purpose: ["OWNER", "messaging"],
      },
    });

    await expect(handleConnectorAccountRoutes(ctx)).resolves.toBe(true);
    expect(captured.status).toBe(201);
    expect(captured.body).toMatchObject({
      id: "acct_google_array",
      role: "OWNER",
      purpose: ["messaging"],
    });
  });

  it("does not serialize disabled metadata defaults as active defaults", async () => {
    const { ctx, captured, storage } = createConnectorAccountHarness({
      method: "GET",
      pathname: "/api/connectors/slack/accounts",
    });
    await storage.upsertAccount({
      id: "acct_disabled_default",
      provider: "slack",
      role: "OWNER",
      purpose: ["messaging"],
      accessGate: "open",
      status: "disabled",
      createdAt: 1,
      updatedAt: 1,
      metadata: { isDefault: true },
    });
    await storage.upsertAccount({
      id: "acct_connected",
      provider: "slack",
      role: "OWNER",
      purpose: ["messaging"],
      accessGate: "open",
      status: "connected",
      createdAt: 2,
      updatedAt: 2,
    });

    await expect(handleConnectorAccountRoutes(ctx)).resolves.toBe(true);

    expect(captured.body).toMatchObject({
      defaultAccountId: "acct_connected",
      accounts: expect.arrayContaining([
        expect.objectContaining({
          id: "acct_disabled_default",
          isDefault: false,
        }),
      ]),
    });
  });

  it("requires server-side confirmation for OWNER role and privacy escalation", async () => {
    const { storage } = createConnectorAccountHarness({
      method: "GET",
      pathname: "/api/connectors/slack/accounts",
    });
    await storage.upsertAccount({
      id: "acct_agent",
      provider: "slack",
      role: "AGENT",
      purpose: ["messaging"],
      accessGate: "open",
      status: "connected",
      createdAt: 1,
      updatedAt: 1,
      metadata: { privacy: "owner_only" },
    });

    const roleDenied = createConnectorAccountHarness({
      method: "PATCH",
      pathname: "/api/connectors/slack/accounts/acct_agent",
      storage,
      body: { role: "OWNER" },
    });
    await expect(handleConnectorAccountRoutes(roleDenied.ctx)).resolves.toBe(
      true,
    );
    expect(roleDenied.captured.status).toBe(403);

    const roleConfirmed = createConnectorAccountHarness({
      method: "PATCH",
      pathname: "/api/connectors/slack/accounts/acct_agent",
      storage,
      body: { role: "OWNER", confirmation: { role: "OWNER" } },
    });
    await expect(handleConnectorAccountRoutes(roleConfirmed.ctx)).resolves.toBe(
      true,
    );
    expect(roleConfirmed.captured.body).toMatchObject({ role: "OWNER" });

    const privacyDenied = createConnectorAccountHarness({
      method: "PATCH",
      pathname: "/api/connectors/slack/accounts/acct_agent",
      storage,
      body: { privacy: "public" },
    });
    await expect(handleConnectorAccountRoutes(privacyDenied.ctx)).resolves.toBe(
      true,
    );
    expect(privacyDenied.captured.status).toBe(403);

    const privacyConfirmed = createConnectorAccountHarness({
      method: "PATCH",
      pathname: "/api/connectors/slack/accounts/acct_agent",
      storage,
      body: {
        privacy: "public",
        confirmation: { privacy: "PUBLIC", publicAcknowledged: true },
      },
    });
    await expect(
      handleConnectorAccountRoutes(privacyConfirmed.ctx),
    ).resolves.toBe(true);
    expect(privacyConfirmed.captured.body).toMatchObject({ privacy: "public" });
  });

  it("strips client-controlled policy metadata and owner-binding fields", async () => {
    const { ctx, captured } = createConnectorAccountHarness({
      method: "POST",
      pathname: "/api/connectors/google/accounts",
      body: {
        id: "acct_policy",
        label: "Policy Attempt",
        accessGate: "owner_binding",
        ownerBindingId: "client-binding",
        ownerIdentityId: "client-identity",
        metadata: {
          safe: "visible",
          privacy: "public",
          isDefault: true,
          credentialRefs: [{ vaultRef: "secret" }],
          nested: {
            safe: "nested-visible",
            refresh_token: "refresh-secret",
            privacy: "public",
          },
        },
      },
    });

    await expect(handleConnectorAccountRoutes(ctx)).resolves.toBe(true);

    expect(captured.status).toBe(201);
    expect(captured.body).toMatchObject({
      id: "acct_policy",
      accessGate: "open",
      privacy: "owner_only",
      isDefault: false,
      metadata: {
        safe: "visible",
        nested: {
          safe: "nested-visible",
        },
      },
    });
    expect(captured.body).not.toMatchObject({
      ownerBindingId: "client-binding",
      ownerIdentityId: "client-identity",
    });
    expect(JSON.stringify(captured.body)).not.toContain("refresh-secret");
    expect(JSON.stringify(captured.body)).not.toContain("credentialRefs");
  });

  it("reads connector account audit events with response redaction", async () => {
    const auditReader = {
      listConnectorAccountAuditEvents: vi.fn(async () => [
        {
          id: "audit-1",
          accountId: "acct_1",
          agentId: "00000000-0000-0000-0000-000000000001",
          provider: "google",
          actorId: "owner:test",
          action: "credential.set",
          outcome: "success",
          metadata: {
            accessToken: "ya29.secret",
            nested: {
              refresh_token: "refresh-secret",
              safe: "visible",
            },
          },
          createdAt: 1_700_000_000_000,
        },
      ]),
    };
    const { ctx, captured } = createConnectorAccountHarness({
      method: "GET",
      pathname: "/api/connectors/google/audit/events?limit=5",
      adapter: auditReader,
    });

    await expect(handleConnectorAccountRoutes(ctx)).resolves.toBe(true);

    expect(auditReader.listConnectorAccountAuditEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "google",
        limit: 5,
      }),
    );
    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({
      provider: "google",
      events: [
        {
          id: "audit-1",
          metadata: {
            accessToken: "[REDACTED]",
            nested: {
              refresh_token: "[REDACTED]",
              safe: "visible",
            },
          },
        },
      ],
    });
  });
});
