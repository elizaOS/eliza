import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkedAccountConfig } from "../contracts/service-routing";
import {
  _resetAccountsRoutesPoolCache,
  type AccountsRouteContext,
  handleAccountsRoutes,
} from "./accounts-routes";

const mockPool = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  upsert: vi.fn(),
  deleteMetadata: vi.fn(),
  refreshUsage: vi.fn(),
}));

vi.mock("@elizaos/app-core/account-pool", () => ({
  getDefaultAccountPool: () => mockPool,
}));

function account(
  providerId: LinkedAccountConfig["providerId"],
  overrides: Partial<LinkedAccountConfig> = {},
): LinkedAccountConfig {
  return {
    id: "duplicate-id",
    providerId,
    label: `${providerId} account`,
    source: "oauth",
    enabled: true,
    priority: 0,
    createdAt: 1,
    health: "ok",
    ...overrides,
  };
}

async function invoke(
  method: string,
  pathname: string,
  body: Record<string, unknown>,
): Promise<{ status: number; payload: unknown }> {
  let status = 200;
  let payload: unknown;
  const ctx: AccountsRouteContext = {
    req: { url: pathname } as IncomingMessage,
    res: {} as ServerResponse,
    method,
    pathname,
    state: { config: {} },
    saveConfig: () => {},
    readJsonBody: async () => body,
    json: (_res, data, nextStatus = 200) => {
      status = nextStatus;
      payload = data;
    },
    error: (_res, message, nextStatus = 400) => {
      status = nextStatus;
      payload = { error: message };
    },
  };
  await handleAccountsRoutes(ctx);
  return { status, payload };
}

describe("handleAccountsRoutes provider-scoped account lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetAccountsRoutesPoolCache();
  });

  it("patches the account under the route provider when account ids collide", async () => {
    const anthropic = account("anthropic-subscription", {
      label: "Anthropic",
    });
    const codex = account("openai-codex", {
      label: "Codex",
    });
    mockPool.get.mockImplementation(
      (accountId: string, providerId?: LinkedAccountConfig["providerId"]) => {
        if (accountId !== "duplicate-id") return null;
        if (providerId === "openai-codex") return codex;
        if (providerId === "anthropic-subscription") return anthropic;
        return anthropic;
      },
    );

    const result = await invoke(
      "PATCH",
      "/api/accounts/openai-codex/duplicate-id",
      { enabled: false },
    );

    expect(result.status).toBe(200);
    expect(mockPool.get).toHaveBeenCalledWith("duplicate-id", "openai-codex");
    expect(mockPool.upsert).toHaveBeenCalledWith({
      ...codex,
      enabled: false,
    });
  });
});
