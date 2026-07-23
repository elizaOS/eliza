/** Exercises account API route behavior with deterministic auth and storage fixtures. */
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import {
  deleteAccount,
  listAccounts,
  saveAccount,
} from "@elizaos/auth/account-storage";
import { getAccessToken } from "@elizaos/auth/credentials";
import type { LinkedAccountConfig } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountsRouteContext } from "../../src/api/accounts-routes";
import {
  __clearSubscriptionCliInstallFailures,
  _resetAccountsRoutesPoolCache,
  ensureSubscriptionCli,
  handleAccountsRoutes,
} from "../../src/api/accounts-routes";
import {
  _resetAgentHostBridge,
  defaultAgentHostBridge,
  setAgentHostBridge,
} from "../../src/runtime/host-bridge.ts";

const poolMock = {
  list: vi.fn(),
  get: vi.fn(),
  upsert: vi.fn(),
  deleteMetadata: vi.fn(),
  refreshUsage: vi.fn(),
  selectionState: vi.fn(),
};

vi.mock("@elizaos/auth/account-storage", () => ({
  deleteAccount: vi.fn(),
  listAccounts: vi.fn(() => []),
  loadAccount: vi.fn(() => null),
  saveAccount: vi.fn(),
}));

vi.mock("@elizaos/auth/credentials", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@elizaos/auth/credentials")>();
  return { ...actual, getAccessToken: vi.fn(async () => null) };
});

function linkedAccount(
  providerId: LinkedAccountConfig["providerId"],
  overrides: Partial<LinkedAccountConfig> = {},
): LinkedAccountConfig {
  return {
    id: "shared-id",
    providerId,
    label: providerId,
    source: "oauth",
    enabled: true,
    priority: 0,
    createdAt: 1,
    health: "ok",
    ...overrides,
  };
}

function createContext(
  overrides: { method?: string; pathname?: string; body?: unknown } = {},
): AccountsRouteContext & {
  body?: unknown;
  status?: number;
} {
  const req = new IncomingMessage(new Socket());
  req.url =
    overrides.pathname ?? "/api/accounts/anthropic-subscription/shared-id";
  const res = new ServerResponse(req);
  const ctx = {
    req,
    res,
    method: overrides.method ?? "PATCH",
    pathname:
      overrides.pathname ?? "/api/accounts/anthropic-subscription/shared-id",
    state: { config: {} },
    saveConfig: vi.fn(),
    readJsonBody: vi.fn(async () => overrides.body ?? { enabled: false }),
    json: vi.fn((_res: ServerResponse, body: unknown, status?: number) => {
      ctx.body = body;
      ctx.status = status ?? 200;
    }),
    error: vi.fn((_res: ServerResponse, message: string, status = 500) => {
      ctx.body = { error: message };
      ctx.status = status;
    }),
  } as AccountsRouteContext & { body?: unknown; status?: number };
  return ctx;
}

describe("accounts routes provider-scoped account resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __clearSubscriptionCliInstallFailures();
    _resetAccountsRoutesPoolCache();
    // The routes read the pool through the host-bridge seam (not an
    // @elizaos/app-core import), so the fixture pool is installed the same
    // way a real host installs it.
    setAgentHostBridge({
      ...defaultAgentHostBridge,
      getDefaultAccountPool: () => poolMock,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    _resetAgentHostBridge();
  });

  it("leaves unrelated API paths to the next dispatcher", async () => {
    const ctx = createContext({
      method: "GET",
      pathname: "/api/orchestrator/status",
    });
    expect(await handleAccountsRoutes(ctx)).toBe(false);
    expect(ctx.body).toBeUndefined();
  });

  it("sends the oauth beta header when testing an anthropic subscription", async () => {
    vi.mocked(getAccessToken).mockResolvedValue("sk-ant-oat01-test");
    poolMock.get.mockReturnValue(linkedAccount("anthropic-subscription"));
    const fetchMock = vi.fn(
      async () => new Response('{"id":"msg_1"}', { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createContext({
      method: "POST",
      pathname: "/api/accounts/anthropic-subscription/shared-id/test",
    });

    const handled = await handleAccountsRoutes(ctx);

    expect(handled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(headers.Authorization).toBe("Bearer sk-ant-oat01-test");
    expect(ctx.body).toMatchObject({ ok: true, status: 200 });
  });

  it("patches the provider-matching account when ids collide", async () => {
    const openai = linkedAccount("openai-codex");
    const anthropic = linkedAccount("anthropic-subscription");
    poolMock.get.mockImplementation((accountId, providerId) => {
      if (accountId !== "shared-id") return null;
      return providerId === "anthropic-subscription" ? anthropic : openai;
    });
    poolMock.upsert.mockResolvedValue(undefined);
    const ctx = createContext();

    const handled = await handleAccountsRoutes(ctx);

    expect(handled).toBe(true);
    expect(poolMock.get).toHaveBeenCalledWith(
      "shared-id",
      "anthropic-subscription",
    );
    expect(poolMock.upsert).toHaveBeenCalledWith({
      ...anthropic,
      enabled: false,
    });
    expect((ctx.body as LinkedAccountConfig).providerId).toBe(
      "anthropic-subscription",
    );
  });

  it("returns a typed not-found response for a missing account patch", async () => {
    poolMock.get.mockReturnValue(null);
    const ctx = createContext({
      method: "PATCH",
      pathname: "/api/accounts/openai-api/missing",
      body: { enabled: false },
    });
    expect(await handleAccountsRoutes(ctx)).toBe(true);
    expect(ctx.status).toBe(404);
    expect(ctx.body).toEqual({ error: "Account not found" });
  });

  it("updates provider strategy through the config boundary", async () => {
    const ctx = createContext({
      method: "PATCH",
      pathname: "/api/providers/openai-api/strategy",
      body: { strategy: "round-robin" },
    });
    expect(await handleAccountsRoutes(ctx)).toBe(true);
    expect(ctx.saveConfig).toHaveBeenCalledWith(ctx.state.config);
    expect(ctx.body).toEqual({
      providerId: "openai-api",
      strategy: "round-robin",
    });
  });

  it("rejects invalid providers and strategy values explicitly", async () => {
    const unknown = createContext({
      method: "PATCH",
      pathname: "/api/providers/not-real/strategy",
    });
    await handleAccountsRoutes(unknown);
    expect(unknown.status).toBe(400);

    const invalid = createContext({
      method: "PATCH",
      pathname: "/api/providers/openai-api/strategy",
      body: { strategy: "random" },
    });
    await handleAccountsRoutes(invalid);
    expect(invalid.status).toBe(400);
  });

  it("deletes both pool metadata and the matching credential", async () => {
    const ctx = createContext({
      method: "DELETE",
      pathname: "/api/accounts/openai-api/shared-id",
    });
    expect(await handleAccountsRoutes(ctx)).toBe(true);
    expect(poolMock.deleteMetadata.mock.calls).toEqual([
      ["openai-api", "shared-id"],
    ]);
    expect(vi.mocked(deleteAccount).mock.calls).toEqual([
      ["openai-api", "shared-id"],
    ]);
    expect(ctx.body).toEqual({ deleted: true });
  });

  it("returns honest test and usage failures when credentials are absent", async () => {
    poolMock.get.mockReturnValue(linkedAccount("openai-api"));
    vi.mocked(getAccessToken).mockResolvedValue(null);
    const test = createContext({
      method: "POST",
      pathname: "/api/accounts/openai-api/shared-id/test",
    });
    await handleAccountsRoutes(test);
    expect(test.body).toEqual({ ok: false, error: "No credential available" });

    const usage = createContext({
      method: "POST",
      pathname: "/api/accounts/openai-api/shared-id/refresh-usage",
    });
    await handleAccountsRoutes(usage);
    expect(usage.status).toBe(400);
    expect(usage.body).toEqual({ error: "No credential available" });
  });

  it("refreshes direct-provider health through a real HTTP response boundary", async () => {
    const account = linkedAccount("openai-api", { health: "unknown" });
    poolMock.get.mockReturnValue(account);
    poolMock.upsert.mockResolvedValue(undefined);
    vi.mocked(getAccessToken).mockResolvedValue("sk-openai-test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"data":[]}', { status: 200 })),
    );
    const ctx = createContext({
      method: "POST",
      pathname: "/api/accounts/openai-api/shared-id/refresh-usage",
    });
    expect(await handleAccountsRoutes(ctx)).toBe(true);
    expect(poolMock.upsert.mock.calls).toEqual([
      [expect.objectContaining({ id: "shared-id", health: "ok" })],
    ]);
    expect(ctx.body).toMatchObject({ account: { health: "ok" } });
  });

  it("reports an absent external-CLI credential without fabricating success", async () => {
    const ctx = createContext({
      method: "POST",
      pathname: "/api/accounts/gemini-cli/shared-id/test",
    });
    expect(await handleAccountsRoutes(ctx)).toBe(true);
    expect(ctx.body).toMatchObject({
      ok: false,
      error: expect.stringContaining(
        "Gemini subscription credentials stay inside Gemini CLI",
      ),
    });
  });

  it("surfaces runtime eligibility so Fable subscription chat is honestly blocked", async () => {
    poolMock.list.mockImplementation((providerId?: string) =>
      providerId === "anthropic-subscription"
        ? [linkedAccount("anthropic-subscription")]
        : [],
    );
    const ctx = createContext({ method: "GET", pathname: "/api/accounts" });

    const handled = await handleAccountsRoutes(ctx);

    expect(handled).toBe(true);
    const response = ctx.body as {
      providers: Array<{
        providerId: string;
        runtimeEligibility: {
          chat: {
            available: boolean;
            defaultModel?: string;
            unavailableReason?: string;
          };
          codingAgent: { available: boolean; defaultModel?: string };
        };
      }>;
    };
    const anthropic = response.providers.find(
      (entry) => entry.providerId === "anthropic-subscription",
    );
    expect(anthropic?.runtimeEligibility.chat).toMatchObject({
      available: false,
      defaultModel: "claude-fable-5",
    });
    expect(anthropic?.runtimeEligibility.chat.unavailableReason).toContain(
      "Claude Code CLI/coding-agent",
    );
    expect(anthropic?.runtimeEligibility.codingAgent).toMatchObject({
      available: true,
      defaultModel: "claude-fable-5",
    });
  });

  it("keeps Codex marked chat-capable through the account-pool path", async () => {
    poolMock.list.mockReturnValue([]);
    const ctx = createContext({ method: "GET", pathname: "/api/accounts" });

    const handled = await handleAccountsRoutes(ctx);

    expect(handled).toBe(true);
    const response = ctx.body as {
      providers: Array<{
        providerId: string;
        runtimeEligibility: {
          chat: { available: boolean; credentialPath?: string };
        };
      }>;
    };
    const codex = response.providers.find(
      (entry) => entry.providerId === "openai-codex",
    );
    expect(codex?.runtimeEligibility.chat).toMatchObject({
      available: true,
      credentialPath: "account-pool",
    });
  });

  it("lists multiple accounts for a single provider", async () => {
    const personal = linkedAccount("openai-codex", {
      id: "personal",
      label: "Personal",
      priority: 1,
    });
    const work = linkedAccount("openai-codex", {
      id: "work",
      label: "Work",
      priority: 0,
    });
    poolMock.list.mockImplementation((providerId?: string) => {
      return providerId === "openai-codex" ? [personal, work] : [];
    });
    vi.mocked(listAccounts).mockImplementation((providerId) => {
      if (providerId !== "openai-codex") return [];
      return [
        {
          id: "personal",
          providerId: "openai-codex",
          label: "Personal",
          source: "oauth",
          credentials: { access: "a", refresh: "r", expires: 1 },
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "work",
          providerId: "openai-codex",
          label: "Work",
          source: "oauth",
          credentials: { access: "b", refresh: "r", expires: 1 },
          createdAt: 2,
          updatedAt: 2,
        },
      ];
    });
    const ctx = createContext({ method: "GET", pathname: "/api/accounts" });

    const handled = await handleAccountsRoutes(ctx);

    expect(handled).toBe(true);
    const response = ctx.body as {
      providers: Array<{
        providerId: string;
        accounts: Array<LinkedAccountConfig & { hasCredential: boolean }>;
      }>;
    };
    const openai = response.providers.find(
      (entry) => entry.providerId === "openai-codex",
    );
    expect(openai?.accounts.map((account) => account.id)).toEqual([
      "work",
      "personal",
    ]);
    expect(openai?.accounts.every((account) => account.hasCredential)).toBe(
      true,
    );
  });

  it("adds sanitized broker observability to the accounts response", async () => {
    const personal = linkedAccount("openai-codex", {
      id: "personal",
      label: "Personal",
      priority: 0,
    });
    const work = linkedAccount("openai-codex", {
      id: "work",
      label: "Work",
      priority: 1,
    });
    poolMock.list.mockImplementation((providerId?: string) => {
      return providerId === "openai-codex" ? [personal, work] : [];
    });
    poolMock.selectionState.mockReturnValue({
      activeAccountId: "work",
      reason: "least-used",
    });
    setAgentHostBridge({
      ...defaultAgentHostBridge,
      getDefaultAccountPool: () => poolMock,
      getAccountPoolBrokerSnapshot: () => ({
        accounts: {
          "openai-codex:work": {
            activeLeaseCount: 2,
            lastLeaseAt: 1234,
            lastLease: {
              leaseId: "opaque-lease",
              atMs: 1234,
              sessionKeyHash: "fixture-session-hash",
              model: "gpt-5.6-terra",
            },
            lastReportedStatus: {
              atMs: 1250,
              ok: false,
              category: "rate_limit",
              reason: "http_429",
              httpStatus: 429,
            },
          },
        },
        providers: {
          "openai-codex": {
            lastSelection: {
              accountId: "work",
              atMs: 1234,
              reason: "least-used",
            },
            recentFailovers: [
              {
                atMs: 1234,
                providerId: "openai-codex",
                sessionKeyHash: "fixture-session-hash",
                fromAccountId: "personal",
                toAccountId: "work",
                cause: { category: "rate_limit", reason: "http_429" },
              },
            ],
          },
        },
      }),
    });
    _resetAccountsRoutesPoolCache();
    const ctx = createContext({ method: "GET", pathname: "/api/accounts" });

    const handled = await handleAccountsRoutes(ctx);

    expect(handled).toBe(true);
    const response = ctx.body as {
      providers: Array<{
        providerId: string;
        observability: {
          lastSelection: { accountId: string; atMs: number } | null;
          recentFailovers: unknown[];
        };
        accounts: Array<{
          id: string;
          observability: {
            activeLeaseCount: number;
            lastLeaseAt: number | null;
            servedLastRequest: boolean;
          };
        }>;
      }>;
    };
    const codex = response.providers.find(
      (entry) => entry.providerId === "openai-codex",
    );
    expect(codex?.observability.lastSelection).toEqual({
      accountId: "work",
      atMs: 1234,
    });
    expect(codex?.observability.recentFailovers).toEqual([
      {
        fromAccountId: "personal",
        toAccountId: "work",
        atMs: 1234,
        cause: "http_429",
      },
    ]);
    expect(codex?.accounts).toEqual([
      expect.objectContaining({
        id: "personal",
        observability: {
          activeLeaseCount: 0,
          lastLeaseAt: null,
          servedLastRequest: false,
        },
      }),
      expect.objectContaining({
        id: "work",
        observability: {
          activeLeaseCount: 2,
          lastLeaseAt: 1234,
          servedLastRequest: true,
        },
      }),
    ]);
    expect(JSON.stringify(codex)).not.toContain("raw-session");
    expect(JSON.stringify(codex)).not.toContain("refresh");
    expect(JSON.stringify(codex)).not.toContain("accessToken");
  });

  it("returns explicit empty observability when the broker has no state", async () => {
    const personal = linkedAccount("openai-codex", {
      id: "personal",
      label: "Personal",
    });
    poolMock.list.mockImplementation((providerId?: string) =>
      providerId === "openai-codex" ? [personal] : [],
    );
    poolMock.selectionState.mockReturnValue(undefined);
    setAgentHostBridge({
      ...defaultAgentHostBridge,
      getDefaultAccountPool: () => poolMock,
      getAccountPoolBrokerSnapshot: () => ({ accounts: {}, providers: {} }),
    });
    _resetAccountsRoutesPoolCache();
    const ctx = createContext({ method: "GET", pathname: "/api/accounts" });

    expect(await handleAccountsRoutes(ctx)).toBe(true);

    const response = ctx.body as {
      providers: Array<{
        providerId: string;
        observability: {
          lastSelection: unknown;
          recentFailovers: unknown[];
        };
        accounts: Array<{
          id: string;
          observability: {
            activeLeaseCount: number;
            lastLeaseAt: number | null;
            servedLastRequest: boolean;
          };
        }>;
      }>;
    };
    const codex = response.providers.find(
      (entry) => entry.providerId === "openai-codex",
    );
    expect(codex?.observability).toEqual({
      lastSelection: null,
      recentFailovers: [],
    });
    expect(codex?.accounts).toEqual([
      expect.objectContaining({
        id: "personal",
        observability: {
          activeLeaseCount: 0,
          lastLeaseAt: null,
          servedLastRequest: false,
        },
      }),
    ]);
  });

  it("rejects malformed OAuth code and cancellation requests", async () => {
    const submit = createContext({
      method: "POST",
      pathname: "/api/accounts/anthropic-subscription/oauth/submit-code",
      body: {},
    });
    expect(await handleAccountsRoutes(submit)).toBe(true);
    expect(submit.status).toBe(400);

    const cancel = createContext({
      method: "POST",
      pathname: "/api/accounts/anthropic-subscription/oauth/cancel",
      body: {},
    });
    expect(await handleAccountsRoutes(cancel)).toBe(true);
    expect(cancel.status).toBe(400);
  });

  it("rejects external or unavailable subscription providers as imported API keys", async () => {
    for (const [providerId, expected] of [
      ["gemini-cli", "Gemini subscription auth must stay in Gemini CLI"],
      [
        "deepseek-coding",
        "DeepSeek does not expose a first-party coding subscription surface",
      ],
    ] as const) {
      const ctx = createContext({
        method: "POST",
        pathname: `/api/accounts/${providerId}`,
        body: {
          source: "api-key",
          label: "Subscription",
          apiKey: "sk-test-subscription-key",
        },
      });

      const handled = await handleAccountsRoutes(ctx);

      expect(handled).toBe(true);
      expect(ctx.status).toBe(400);
      expect((ctx.body as { error: string }).error).toContain(expected);
    }
  });

  it("allows coding-plan credentials only on dedicated coding-plan providers", async () => {
    poolMock.list.mockReturnValue([]);
    poolMock.upsert.mockResolvedValue(undefined);
    const ctx = createContext({
      method: "POST",
      pathname: "/api/accounts/zai-coding",
      body: {
        source: "api-key",
        label: "z.ai Coding",
        apiKey: "sk-test-zai-coding-key",
      },
    });

    const handled = await handleAccountsRoutes(ctx);

    expect(handled).toBe(true);
    expect(ctx.status).toBe(201);
    expect(poolMock.upsert.mock.calls).toEqual([
      [
        expect.objectContaining({
          providerId: "zai-coding",
          label: "z.ai Coding",
          source: "api-key",
        }),
      ],
    ]);
  });

  it("keeps z.ai coding-plan and direct API accounts in separate credential pools", async () => {
    vi.stubEnv("ZAI_API_KEY", "");
    vi.stubEnv("Z_AI_API_KEY", undefined);
    poolMock.list.mockImplementation((providerId?: string) => {
      if (providerId === "zai-coding") {
        return [
          linkedAccount("zai-coding", {
            id: "existing-coding",
            priority: 0,
          }),
        ];
      }
      return [];
    });
    poolMock.upsert.mockResolvedValue(undefined);
    const codingCtx = createContext({
      method: "POST",
      pathname: "/api/accounts/zai-coding",
      body: {
        source: "api-key",
        label: "z.ai Coding Work",
        apiKey: "sk-test-zai-coding-key",
      },
    });

    const codingHandled = await handleAccountsRoutes(codingCtx);

    expect(codingHandled).toBe(true);
    expect(codingCtx.status).toBe(201);
    expect(process.env.ZAI_API_KEY).toBe("");
    expect(process.env.Z_AI_API_KEY).toBeUndefined();
    expect(codingCtx.body).toMatchObject({
      providerId: "zai-coding",
      label: "z.ai Coding Work",
      source: "api-key",
      priority: 1,
    });

    const directCtx = createContext({
      method: "POST",
      pathname: "/api/accounts/zai-api",
      body: {
        source: "api-key",
        label: "z.ai API",
        apiKey: "sk-test-zai-api-key",
      },
    });

    const directHandled = await handleAccountsRoutes(directCtx);

    expect(directHandled).toBe(true);
    expect(directCtx.status).toBe(201);
    expect(process.env.ZAI_API_KEY).toBe("sk-test-zai-api-key");
    expect(process.env.Z_AI_API_KEY).toBe("sk-test-zai-api-key");
    expect(vi.mocked(saveAccount).mock.calls.map(([record]) => record)).toEqual(
      [
        expect.objectContaining({
          providerId: "zai-coding",
          label: "z.ai Coding Work",
          source: "api-key",
        }),
        expect.objectContaining({
          providerId: "zai-api",
          label: "z.ai API",
          source: "api-key",
        }),
      ],
    );
  });

  it("installs a missing subscription CLI into the per-user prefix", async () => {
    let availabilityChecks = 0;
    const isAvailable = vi.fn(async () => availabilityChecks++ > 0);
    const runInstall = vi.fn(async (_args: string[]) => undefined);

    await ensureSubscriptionCli("openai-codex", { isAvailable, runInstall });

    expect(runInstall).toHaveBeenCalledTimes(1);
    const installArgs = runInstall.mock.calls[0]?.[0] ?? [];
    expect(installArgs[0]).toBe("install");
    expect(installArgs).toContain("--prefix");
    expect(installArgs).toContain("@openai/codex");
    expect(isAvailable).toHaveBeenCalledWith("codex");
  });

  it("caches a failed CLI install and skips reinstall during the cooldown", async () => {
    const isAvailable = vi.fn(async () => false);
    let nowMs = 10_000;
    const failingInstall = vi.fn(async () => {
      throw new Error("npm exploded");
    });

    const firstError = await ensureSubscriptionCli("anthropic-subscription", {
      isAvailable,
      runInstall: failingInstall,
      now: () => nowMs,
    }).then(
      () => null,
      (err: unknown) => err as { code?: string },
    );
    expect(firstError?.code).toBe("SUBSCRIPTION_CLI_INSTALL_FAILED");

    // Inside the cooldown the cached failure is rethrown without re-running
    // npm, even though this attempt's install would have succeeded.
    nowMs += 1_000;
    const recoveredInstall = vi.fn(async () => undefined);
    const cachedError = await ensureSubscriptionCli("anthropic-subscription", {
      isAvailable,
      runInstall: recoveredInstall,
      now: () => nowMs,
    }).then(
      () => null,
      (err: unknown) => err as { code?: string },
    );
    expect(cachedError?.code).toBe("SUBSCRIPTION_CLI_INSTALL_FAILED");
    expect(recoveredInstall).not.toHaveBeenCalled();
    expect(failingInstall).toHaveBeenCalledTimes(1);
  });

  it("fails closed when an installed CLI still is not resolvable", async () => {
    const isAvailable = vi.fn(async () => false);
    const runInstall = vi.fn(async () => undefined);

    const error = await ensureSubscriptionCli("openai-codex", {
      isAvailable,
      runInstall,
    }).then(
      () => null,
      (err: unknown) => err as { code?: string },
    );

    expect(error?.code).toBe("SUBSCRIPTION_CLI_NOT_ON_PATH");
    expect(runInstall).toHaveBeenCalledTimes(1);
  });

  it("rejects OAuth for providers without a first-party OAuth surface", async () => {
    const direct = createContext({
      method: "POST",
      pathname: "/api/accounts/openai-api/oauth/start",
      body: { label: "Work" },
    });
    expect(await handleAccountsRoutes(direct)).toBe(true);
    expect(direct.status).toBe(400);
    expect((direct.body as { error: string }).error).toContain(
      "OAuth not supported",
    );

    const externalCli = createContext({
      method: "POST",
      pathname: "/api/accounts/gemini-cli/oauth/start",
      body: { label: "Work" },
    });
    expect(await handleAccountsRoutes(externalCli)).toBe(true);
    expect(externalCli.status).toBe(501);
    expect((externalCli.body as { error: string }).error).toContain(
      "Gemini CLI",
    );
  });

  it("guards the OAuth status stream behind a known sessionId", async () => {
    const missing = createContext({
      method: "GET",
      pathname: "/api/accounts/anthropic-subscription/oauth/status",
    });
    expect(await handleAccountsRoutes(missing)).toBe(true);
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({ error: "Missing sessionId" });

    const unknown = createContext({
      method: "GET",
      pathname: "/api/accounts/anthropic-subscription/oauth/status",
    });
    unknown.req.url =
      "/api/accounts/anthropic-subscription/oauth/status?sessionId=not-a-real-session";
    expect(await handleAccountsRoutes(unknown)).toBe(true);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: "Unknown sessionId" });
  });

  it("reports unknown OAuth sessions honestly on submit and cancel", async () => {
    const submit = createContext({
      method: "POST",
      pathname: "/api/accounts/anthropic-subscription/oauth/submit-code",
      body: { sessionId: "not-a-real-session", code: "123456" },
    });
    expect(await handleAccountsRoutes(submit)).toBe(true);
    expect(submit.status).toBe(400);
    expect(submit.body).toEqual({
      error: "No active flow accepts a code submission",
    });

    const cancel = createContext({
      method: "POST",
      pathname: "/api/accounts/anthropic-subscription/oauth/cancel",
      body: { sessionId: "not-a-real-session" },
    });
    expect(await handleAccountsRoutes(cancel)).toBe(true);
    expect(cancel.body).toEqual({ cancelled: false });
  });

  it("tests coding-plan credentials against the plan's models endpoint", async () => {
    vi.stubEnv("ZAI_CODING_BASE_URL", "");
    vi.stubEnv("Z_AI_CODING_BASE_URL", "");
    poolMock.get.mockReturnValue(linkedAccount("zai-coding"));
    vi.mocked(getAccessToken).mockResolvedValue("sk-test-zai-coding-key");
    const fetchMock = vi.fn(
      async () => new Response('{"data":[]}', { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createContext({
      method: "POST",
      pathname: "/api/accounts/zai-coding/shared-id/test",
    });

    expect(await handleAccountsRoutes(ctx)).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.z.ai/api/coding/paas/v4/models");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-test-zai-coding-key",
    );
    expect(ctx.body).toMatchObject({ ok: true, status: 200 });
  });

  it("marks a coding-plan account needs-reauth when the plan rejects its key", async () => {
    vi.stubEnv("KIMI_CODING_BASE_URL", "");
    poolMock.get.mockReturnValue(linkedAccount("kimi-coding"));
    poolMock.upsert.mockResolvedValue(undefined);
    vi.mocked(getAccessToken).mockResolvedValue("sk-test-kimi-coding-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );
    const ctx = createContext({
      method: "POST",
      pathname: "/api/accounts/kimi-coding/shared-id/refresh-usage",
    });

    expect(await handleAccountsRoutes(ctx)).toBe(true);

    expect(poolMock.upsert.mock.calls).toEqual([
      [expect.objectContaining({ id: "shared-id", health: "needs-reauth" })],
    ]);
    expect(ctx.body).toMatchObject({
      source: "coding-plan-probe",
      account: { health: "needs-reauth" },
      probe: { ok: false, status: 401 },
    });
  });

  it("refreshes OAuth subscription usage through the pool singleton", async () => {
    const linked = linkedAccount("anthropic-subscription");
    const refreshed = { ...linked, usage: { refreshedAt: 42 } };
    poolMock.get.mockReturnValueOnce(linked).mockReturnValue(refreshed);
    poolMock.refreshUsage.mockResolvedValue(undefined);
    vi.mocked(getAccessToken).mockResolvedValue("sk-ant-oat01-live");
    const ctx = createContext({
      method: "POST",
      pathname: "/api/accounts/anthropic-subscription/shared-id/refresh-usage",
    });

    expect(await handleAccountsRoutes(ctx)).toBe(true);

    expect(poolMock.refreshUsage).toHaveBeenCalledWith(
      "shared-id",
      "sk-ant-oat01-live",
      { providerId: "anthropic-subscription" },
    );
    expect(ctx.body).toMatchObject({
      source: "pool",
      account: { usage: { refreshedAt: 42 } },
    });
  });

  it("falls back to the inline probe when the pool usage refresh fails", async () => {
    const linked = linkedAccount("anthropic-subscription");
    poolMock.get.mockReturnValue(linked);
    poolMock.refreshUsage.mockRejectedValue(new Error("usage endpoint down"));
    poolMock.upsert.mockResolvedValue(undefined);
    vi.mocked(getAccessToken).mockResolvedValue("sk-ant-oat01-live");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"id":"msg_1"}', { status: 200 })),
    );
    const ctx = createContext({
      method: "POST",
      pathname: "/api/accounts/anthropic-subscription/shared-id/refresh-usage",
    });

    expect(await handleAccountsRoutes(ctx)).toBe(true);

    expect(poolMock.upsert.mock.calls).toEqual([
      [expect.objectContaining({ id: "shared-id", health: "ok" })],
    ]);
    expect(ctx.body).toMatchObject({
      source: "inline-probe",
      account: { health: "ok" },
      probe: { ok: true },
    });
  });
});
