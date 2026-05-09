import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { LinkedAccountConfig } from "@elizaos/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountsRouteContext } from "../../src/api/accounts-routes";
import {
  _resetAccountsRoutesPoolCache,
  handleAccountsRoutes,
} from "../../src/api/accounts-routes";

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
  };
}

function createContext(): AccountsRouteContext & {
  body?: unknown;
  status?: number;
} {
  const req = new IncomingMessage(new Socket());
  req.url = "/api/accounts/anthropic-subscription/shared-id";
  const res = new ServerResponse(req);
  const ctx = {
    req,
    res,
    method: "PATCH",
    pathname: "/api/accounts/anthropic-subscription/shared-id",
    state: { config: {} },
    saveConfig: vi.fn(),
    readJsonBody: vi.fn(async () => ({ enabled: false })),
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
});
