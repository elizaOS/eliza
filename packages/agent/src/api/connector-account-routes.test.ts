import type { IncomingMessage, ServerResponse } from "node:http";
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

    async startOAuth(provider: string) {
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

  return { getConnectorAccountManager, InMemoryConnectorAccountStorage };
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
    readJsonBody: vi.fn(async () => options.body ?? {}),
    json: (_res, data, status = 200) => {
      captured.status = status;
      captured.body = data;
    },
    error: (_res, message, status = 500) => {
      captured.status = status;
      captured.body = { error: message };
    },
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

  it("persists OAuth start state through the connector account storage contract", async () => {
    const { ctx, captured, runtime, storage } = createConnectorAccountHarness({
      method: "POST",
      pathname: "/api/connectors/slack/oauth/start",
      body: { label: "Work Slack" },
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
      flow: { id: string; state: string; authUrl: string };
    };
    expect(startBody.flow.authUrl).toContain(startBody.flow.state);

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
