/**
 * Drives the accounts HTTP boundary through credential, OAuth, strategy, and
 * health operations while isolating only filesystem and provider clients.
 */
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  accounts: [] as Array<Record<string, unknown>>,
  poolAccounts: [] as Array<Record<string, unknown>>,
  deleteAccount: vi.fn(),
  getAccessToken: vi.fn(async () => "access-token"),
  probeDirectApiKey: vi.fn(
    async (): Promise<{
      ok: boolean;
      status: number;
      latencyMs: number;
      error?: string;
    }> => ({
      ok: true,
      status: 200,
      latencyMs: 4,
    }),
  ),
  saveAccount: vi.fn(),
  submitFlowCode: vi.fn(() => true),
  cancelFlow: vi.fn(() => true),
  getFlowState: vi.fn(),
  subscribeFlow: vi.fn(() => vi.fn()),
  startFlow: vi.fn(async () => ({
    sessionId: "session-1",
    authUrl: "https://provider.example/authorize",
    needsCodeSubmission: true,
  })),
  pool: {
    list: vi.fn((providerId?: string) =>
      fakes.poolAccounts.filter(
        (account) => !providerId || account.providerId === providerId,
      ),
    ),
    get: vi.fn((accountId: string, providerId?: string) =>
      fakes.poolAccounts.find(
        (account) =>
          account.id === accountId &&
          (!providerId || account.providerId === providerId),
      ),
    ),
    upsert: vi.fn(async (account: Record<string, unknown>) => {
      const index = fakes.poolAccounts.findIndex(
        (candidate) => candidate.id === account.id,
      );
      if (index >= 0) fakes.poolAccounts[index] = account;
      else fakes.poolAccounts.push(account);
    }),
    deleteMetadata: vi.fn(async (_providerId: string, accountId: string) => {
      fakes.poolAccounts = fakes.poolAccounts.filter(
        (account) => account.id !== accountId,
      );
    }),
    refreshUsage: vi.fn(async () => undefined),
    selectionState: vi.fn(() => ({
      activeAccountId: "account-1",
      reason: "highest priority healthy account",
    })),
  },
}));

vi.mock("@elizaos/auth/account-storage", () => ({
  listAccounts: () => fakes.accounts,
  loadAccount: (_providerId: string, accountId: string) =>
    fakes.accounts.find((account) => account.id === accountId),
  saveAccount: fakes.saveAccount,
  deleteAccount: fakes.deleteAccount,
}));
vi.mock("@elizaos/auth/codex-usage", () => ({
  fetchCodexUsage: vi.fn(),
}));
vi.mock("@elizaos/auth/credentials", () => ({
  getAccessToken: fakes.getAccessToken,
}));
vi.mock("@elizaos/auth/direct-api-probe", () => ({
  probeDirectApiKey: fakes.probeDirectApiKey,
}));
vi.mock("@elizaos/auth/oauth-flow", () => ({
  cancelFlow: fakes.cancelFlow,
  getFlowState: fakes.getFlowState,
  startAnthropicOAuthFlow: fakes.startFlow,
  startCodexOAuthFlow: fakes.startFlow,
  submitFlowCode: fakes.submitFlowCode,
  subscribeFlow: fakes.subscribeFlow,
}));
vi.mock("../runtime/host-bridge.ts", () => ({
  getAgentHostBridge: () => ({ getDefaultAccountPool: () => fakes.pool }),
}));

import {
  _resetAccountsRoutesPoolCache,
  type AccountsRouteContext,
  handleAccountsRoutes,
} from "./accounts-routes.ts";

type JsonCall = { body: unknown; status?: number };
type ErrorCall = { message: string; status: number };

function makeContext(
  method: string,
  pathname: string,
  body?: unknown,
  url = pathname,
): {
  ctx: AccountsRouteContext;
  jsonCalls: JsonCall[];
  errorCalls: ErrorCall[];
  saveConfig: ReturnType<typeof vi.fn>;
  res: EventEmitter & {
    statusCode: number;
    setHeader: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
} {
  const jsonCalls: JsonCall[] = [];
  const errorCalls: ErrorCall[] = [];
  const saveConfig = vi.fn();
  const req = Object.assign(new EventEmitter(), {
    url,
    headers: { host: "localhost:3000" },
  });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 0,
    setHeader: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
  });
  const ctx = {
    req,
    res,
    method,
    pathname,
    state: { config: {} },
    saveConfig,
    json: (_res: unknown, responseBody: unknown, status?: number) => {
      jsonCalls.push({ body: responseBody, ...(status ? { status } : {}) });
    },
    error: (_res: unknown, message: string, status: number) => {
      errorCalls.push({ message, status });
    },
    readJsonBody: vi.fn(async () => body),
  } as unknown as AccountsRouteContext;
  return { ctx, jsonCalls, errorCalls, saveConfig, res };
}

const linkedAccount = {
  id: "account-1",
  providerId: "openai-api",
  label: "Primary",
  source: "api-key",
  enabled: true,
  priority: 0,
  createdAt: 1,
  health: "ok",
};

describe("accounts routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakes.accounts = [];
    fakes.poolAccounts = [];
    fakes.getAccessToken.mockResolvedValue("access-token");
    fakes.probeDirectApiKey.mockResolvedValue({
      ok: true,
      status: 200,
      latencyMs: 4,
    });
    fakes.submitFlowCode.mockReturnValue(true);
    fakes.cancelFlow.mockReturnValue(true);
    _resetAccountsRoutesPoolCache();
  });

  it("ignores unrelated paths and rejects unknown providers", async () => {
    const unrelated = makeContext("GET", "/api/health");
    expect(await handleAccountsRoutes(unrelated.ctx)).toBe(false);

    const unknown = makeContext("POST", "/api/accounts/not-a-provider", {});
    expect(await handleAccountsRoutes(unknown.ctx)).toBe(true);
    expect(unknown.errorCalls).toEqual([
      { message: "Unknown providerId: not-a-provider", status: 400 },
    ]);
  });

  it("persists provider strategy", async () => {
    const strategy = makeContext(
      "PATCH",
      "/api/providers/openai-api/strategy",
      { strategy: "drain-soonest-reset" },
    );
    await handleAccountsRoutes(strategy.ctx);
    expect(strategy.saveConfig).toHaveBeenCalledOnce();
    expect(strategy.jsonCalls[0]?.body).toEqual({
      providerId: "openai-api",
      strategy: "drain-soonest-reset",
    });
  });

  it("lists pool metadata with credentials and runtime capabilities", async () => {
    fakes.poolAccounts = [linkedAccount];
    fakes.accounts = [{ id: "account-1" }];
    const request = makeContext("GET", "/api/accounts");
    await handleAccountsRoutes(request.ctx);
    const response = request.jsonCalls[0]?.body as {
      providers: Array<Record<string, unknown>>;
    };
    expect(
      response.providers.find((item) => item.providerId === "openai-api"),
    ).toMatchObject({
      strategy: "priority",
      accounts: [{ id: "account-1", hasCredential: true }],
      runtimeEligibility: {
        chat: { available: true, credentialPath: "direct-api" },
        codingAgent: { available: true, credentialPath: "direct-api" },
      },
    });
    expect(
      response.providers.find(
        (item) => item.providerId === "anthropic-subscription",
      ),
    ).toMatchObject({
      runtimeEligibility: {
        chat: { available: false, credentialPath: "none" },
        codingAgent: { available: true, credentialPath: "account-pool" },
      },
    });
  });

  it("sets, surfaces, validates, and clears subscriptionEndsAt through PATCH", async () => {
    const future = Date.now() + 86_400_000;
    fakes.poolAccounts = [
      { ...linkedAccount, health: "expired", healthDetail: { lastChecked: 1 } },
    ];
    fakes.accounts = [{ id: "account-1" }];

    const set = makeContext("PATCH", "/api/accounts/openai-api/account-1", {
      subscriptionEndsAt: future,
    });
    await handleAccountsRoutes(set.ctx);
    expect(set.jsonCalls[0]?.body).toMatchObject({
      id: "account-1",
      subscriptionEndsAt: future,
    });

    const listed = makeContext("GET", "/api/accounts");
    await handleAccountsRoutes(listed.ctx);
    const response = listed.jsonCalls[0]?.body as {
      providers: Array<{ providerId: string; accounts: Array<unknown> }>;
    };
    expect(
      response.providers.find(
        (provider) => provider.providerId === "openai-api",
      )?.accounts[0],
    ).toMatchObject({ subscriptionEndsAt: future });

    for (const bad of ["soon", Number.NaN, Number.POSITIVE_INFINITY]) {
      const invalid = makeContext(
        "PATCH",
        "/api/accounts/openai-api/account-1",
        {
          subscriptionEndsAt: bad,
        },
      );
      await handleAccountsRoutes(invalid.ctx);
      expect(invalid.errorCalls[0]?.status).toBe(400);
    }

    const past = makeContext("PATCH", "/api/accounts/openai-api/account-1", {
      subscriptionEndsAt: Date.now() - 1,
    });
    await handleAccountsRoutes(past.ctx);
    expect(past.errorCalls).toEqual([
      {
        message: "subscriptionEndsAt must be a future epoch-ms timestamp",
        status: 400,
      },
    ]);

    const cleared = makeContext("PATCH", "/api/accounts/openai-api/account-1", {
      subscriptionEndsAt: null,
    });
    await handleAccountsRoutes(cleared.ctx);
    const clearedBody = cleared.jsonCalls[0]?.body as Record<string, unknown>;
    expect(clearedBody).toMatchObject({ id: "account-1", health: "ok" });
    expect(clearedBody.subscriptionEndsAt).toBeUndefined();
    expect(clearedBody.healthDetail).toBeUndefined();
  });

  it("creates, edits, probes, refreshes, and deletes a direct account", async () => {
    const created = makeContext("POST", "/api/accounts/openai-api", {
      source: "api-key",
      label: "Secondary",
      apiKey: "sk-test-value",
    });
    await handleAccountsRoutes(created.ctx);
    expect(fakes.saveAccount).toHaveBeenCalledOnce();
    expect(created.jsonCalls[0]?.status).toBe(201);

    fakes.poolAccounts = [{ ...linkedAccount }];
    fakes.accounts = [
      {
        id: "account-1",
        providerId: "openai-api",
        label: "Primary",
      },
    ];
    const patched = makeContext("PATCH", "/api/accounts/openai-api/account-1", {
      label: "Renamed",
      enabled: false,
      priority: 2,
    });
    await handleAccountsRoutes(patched.ctx);
    expect(patched.jsonCalls[0]?.body).toMatchObject({
      label: "Renamed",
      enabled: false,
      priority: 2,
    });

    const tested = makeContext(
      "POST",
      "/api/accounts/openai-api/account-1/test",
    );
    await handleAccountsRoutes(tested.ctx);
    expect(tested.jsonCalls[0]?.body).toEqual({
      ok: true,
      latencyMs: 4,
      status: 200,
    });

    const refreshed = makeContext(
      "POST",
      "/api/accounts/openai-api/account-1/refresh-usage",
    );
    await handleAccountsRoutes(refreshed.ctx);
    expect(refreshed.jsonCalls[0]?.body).toMatchObject({
      source: "direct-probe",
      account: { health: "ok" },
    });

    const deleted = makeContext("DELETE", "/api/accounts/openai-api/account-1");
    await handleAccountsRoutes(deleted.ctx);
    expect(fakes.deleteAccount).toHaveBeenCalledWith("openai-api", "account-1");
    expect(deleted.jsonCalls[0]?.body).toEqual({ deleted: true });
  });

  it("verifies and replaces an API credential in place without duplicating the account", async () => {
    const target = {
      ...linkedAccount,
      health: "invalid",
      healthDetail: { lastError: "credential rejected" },
    };
    fakes.poolAccounts = [target];
    fakes.accounts = [
      {
        id: "account-1",
        providerId: "openai-api",
        label: "Primary",
        source: "api-key",
        credentials: { access: "old-secret" },
        createdAt: 1,
      },
    ];
    const replaced = makeContext("POST", "/api/accounts/openai-api", {
      source: "api-key",
      label: "Primary",
      apiKey: "new-secret-value",
      replaceAccountId: "account-1",
    });
    await handleAccountsRoutes(replaced.ctx);

    expect(fakes.probeDirectApiKey).toHaveBeenCalledWith(
      "openai-api",
      "new-secret-value",
    );
    expect(fakes.saveAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "account-1",
        label: "Primary",
        credentials: expect.objectContaining({ access: "new-secret-value" }),
      }),
    );
    expect(replaced.jsonCalls[0]).toMatchObject({
      status: 200,
      body: { id: "account-1", health: "ok" },
    });
    expect(replaced.jsonCalls[0]?.body).not.toHaveProperty("healthDetail");
    expect(fakes.poolAccounts).toHaveLength(1);
  });

  it("leaves an API credential unchanged when its replacement cannot be verified", async () => {
    fakes.poolAccounts = [{ ...linkedAccount, health: "invalid" }];
    fakes.accounts = [
      {
        id: "account-1",
        providerId: "openai-api",
        label: "Primary",
        credentials: { access: "old-secret" },
      },
    ];
    fakes.probeDirectApiKey.mockResolvedValueOnce({
      ok: false,
      status: 401,
      latencyMs: 4,
      error: "credential rejected",
    });
    const replaced = makeContext("POST", "/api/accounts/openai-api", {
      source: "api-key",
      label: "Primary",
      apiKey: "bad-secret-value",
      replaceAccountId: "account-1",
    });
    await handleAccountsRoutes(replaced.ctx);

    expect(replaced.errorCalls).toEqual([
      { message: "credential rejected", status: 400 },
    ]);
    expect(fakes.saveAccount).not.toHaveBeenCalled();
    expect(fakes.poolAccounts[0]).toMatchObject({ health: "invalid" });
  });

  it("binds OAuth replacement to an existing same-provider account", async () => {
    const target = {
      id: "codex-work",
      providerId: "openai-codex",
      label: "Work Codex",
      source: "oauth",
      enabled: true,
      priority: 3,
      createdAt: 10,
      health: "needs-reauth",
      healthDetail: { lastError: "expired" },
    };
    fakes.poolAccounts = [target];
    fakes.accounts = [{ ...target, credentials: { access: "old" } }];
    const started = makeContext(
      "POST",
      "/api/accounts/openai-codex/oauth/start",
      {
        label: "Work Codex",
        mode: "auto",
        replaceAccountId: "codex-work",
      },
    );
    await handleAccountsRoutes(started.ctx);

    expect(fakes.startFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "codex-work",
        replaceAccountId: "codex-work",
      }),
    );
    const startCalls = fakes.startFlow.mock.calls as unknown as Array<
      [
        {
          onAccountSaved: (record: Record<string, unknown>) => Promise<void>;
        },
      ]
    >;
    const options = startCalls[0]?.[0];
    expect(options).toBeDefined();
    await options?.onAccountSaved({
      id: "codex-work",
      providerId: "openai-codex",
      label: "Work Codex",
      source: "oauth",
      createdAt: 10,
      updatedAt: 20,
    });
    expect(fakes.poolAccounts).toHaveLength(1);
    expect(fakes.poolAccounts[0]).toMatchObject({
      id: "codex-work",
      priority: 3,
      health: "ok",
    });
  });

  it("fails closed when an OAuth replacement target is missing or belongs to another provider", async () => {
    const missing = makeContext(
      "POST",
      "/api/accounts/openai-codex/oauth/start",
      { label: "Missing", replaceAccountId: "gone" },
    );
    await handleAccountsRoutes(missing.ctx);
    expect(missing.errorCalls).toEqual([
      { message: "Replacement account not found", status: 404 },
    ]);

    fakes.poolAccounts = [
      { ...linkedAccount, id: "wrong-provider", providerId: "openai-api" },
    ];
    const mismatch = makeContext(
      "POST",
      "/api/accounts/openai-codex/oauth/start",
      { label: "Wrong", replaceAccountId: "wrong-provider" },
    );
    await handleAccountsRoutes(mismatch.ctx);
    expect(mismatch.errorCalls).toEqual([
      {
        message: "Replacement account belongs to a different provider",
        status: 400,
      },
    ]);
    expect(fakes.startFlow).not.toHaveBeenCalled();
  });

  it("keeps terminal credential health terminal during usage refresh", async () => {
    fakes.poolAccounts = [
      {
        ...linkedAccount,
        health: "needs-reauth",
        healthDetail: { lastError: "refresh token revoked", lastChecked: 1 },
      },
    ];
    const refreshed = makeContext(
      "POST",
      "/api/accounts/openai-api/account-1/refresh-usage",
    );
    await handleAccountsRoutes(refreshed.ctx);
    expect(refreshed.jsonCalls[0]?.body).toMatchObject({
      account: {
        health: "needs-reauth",
        healthDetail: { lastError: "refresh token revoked", lastChecked: 1 },
      },
    });
  });

  it("starts and controls OAuth flows and validates the status stream", async () => {
    const started = makeContext(
      "POST",
      "/api/accounts/openai-codex/oauth/start",
      { label: "Codex", mode: "auto" },
    );
    await handleAccountsRoutes(started.ctx);
    expect(started.jsonCalls[0]?.body).toMatchObject({
      sessionId: "session-1",
      needsCodeSubmission: true,
    });

    const submitted = makeContext(
      "POST",
      "/api/accounts/openai-codex/oauth/submit-code",
      { sessionId: "session-1", code: "code-value" },
    );
    await handleAccountsRoutes(submitted.ctx);
    expect(submitted.jsonCalls[0]?.body).toEqual({ accepted: true });

    const cancelled = makeContext(
      "POST",
      "/api/accounts/openai-codex/oauth/cancel",
      { sessionId: "session-1" },
    );
    await handleAccountsRoutes(cancelled.ctx);
    expect(cancelled.jsonCalls[0]?.body).toEqual({ cancelled: true });

    fakes.getFlowState.mockReturnValue({
      providerId: "openai-codex",
      status: "pending",
    });
    const status = makeContext(
      "GET",
      "/api/accounts/openai-codex/oauth/status",
      undefined,
      "/api/accounts/openai-codex/oauth/status?sessionId=session-1",
    );
    await handleAccountsRoutes(status.ctx);
    expect(status.res.statusCode).toBe(200);
    expect(status.res.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      "text/event-stream",
    );
  });
});
