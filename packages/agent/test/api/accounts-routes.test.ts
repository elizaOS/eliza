import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { LinkedAccountConfig } from "@elizaos/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountsRouteContext } from "../../src/api/accounts-routes";
import {
  _resetAccountsRoutesPoolCache,
  handleAccountsRoutes,
} from "../../src/api/accounts-routes";
import { listAccounts } from "../../src/auth/account-storage.js";

const poolMock = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  upsert: vi.fn(),
  deleteMetadata: vi.fn(),
  refreshUsage: vi.fn(),
}));

vi.mock("@elizaos/app-core", () => ({
  getDefaultAccountPool: () => poolMock,
}));

vi.mock("../../src/auth/account-storage.js", () => ({
  deleteAccount: vi.fn(),
  listAccounts: vi.fn(() => []),
  loadAccount: vi.fn(() => null),
  migrateLegacySingleAccount: vi.fn(),
  saveAccount: vi.fn(),
}));

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
    _resetAccountsRoutesPoolCache();
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
    expect(poolMock.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "zai-coding",
        label: "z.ai Coding",
        source: "api-key",
      }),
    );
  });
});
