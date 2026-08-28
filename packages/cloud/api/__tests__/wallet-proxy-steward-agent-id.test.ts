/** Exercises Steward wallet routing with deterministic Cloud auth, mapping, and upstream fixtures. */
import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import type {
  WalletBalancesResponse,
  WalletConfigStatus,
} from "@elizaos/shared";
// Spread the real module into the partial mock below — `mock.module` is
// process-global, so dropping the other real exports breaks every later
// importer of this shared auth module (e.g. cron routes' `requireCronSecret`).
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";
import * as loggerActual from "@/lib/utils/logger";

const dbRows: Array<{ stewardAgentId: string | null }> = [];
const dbLimit = mock<
  (n: number) => Promise<Array<{ stewardAgentId: string | null }>>
>(async () => dbRows);
const dbWhere = mock<(...args: unknown[]) => { limit: typeof dbLimit }>(() => ({
  limit: dbLimit,
}));
const dbFrom = mock<(...args: unknown[]) => { where: typeof dbWhere }>(() => ({
  where: dbWhere,
}));
const dbSelect = mock<(...args: unknown[]) => { from: typeof dbFrom }>(() => ({
  from: dbFrom,
}));

const requireUserOrApiKeyWithOrg =
  mock<() => Promise<{ id: string; organization_id: string }>>();
const getAgent = mock<(agentId: string, orgId: string) => Promise<unknown>>();
const createStewardClient = mock<() => Promise<StewardClientMock>>();
const loggerInfo = mock<(...args: unknown[]) => void>();

type StewardClientMock = {
  getAddresses: ReturnType<
    typeof mock<
      (agentId: string) => Promise<{
        addresses: Array<{ chainFamily: "evm" | "solana"; address: string }>;
      }>
    >
  >;
  getAgent: ReturnType<
    typeof mock<
      (agentId: string) => Promise<{
        walletAddress?: string | null;
        walletAddresses?: { evm?: string | null; solana?: string | null };
      }>
    >
  >;
  getBalance: ReturnType<
    typeof mock<
      (agentId: string) => Promise<{
        walletAddress?: string;
        balances: {
          native: string;
          nativeFormatted?: string;
          chainId: number;
          symbol: string;
        };
      }>
    >
  >;
  getPolicies: ReturnType<typeof mock<(agentId: string) => Promise<unknown[]>>>;
  setPolicies: ReturnType<
    typeof mock<(agentId: string, policies: unknown[]) => Promise<void>>
  >;
  getAgentDashboard: ReturnType<
    typeof mock<
      (
        agentId: string,
      ) => Promise<{ pendingApprovals: number; recentTransactions: unknown[] }>
    >
  >;
  listPendingApprovals: ReturnType<
    typeof mock<
      (
        agentId: string,
        opts?: { limit?: number; offset?: number },
      ) => Promise<unknown[]>
    >
  >;
  listApprovals: ReturnType<
    typeof mock<(opts?: unknown) => Promise<Array<{ agentId?: string }>>>
  >;
  approveTransaction: ReturnType<
    typeof mock<
      (txId: string, opts?: unknown) => Promise<Record<string, unknown>>
    >
  >;
  denyTransaction: ReturnType<
    typeof mock<
      (
        txId: string,
        reason: string,
        deniedBy?: string,
      ) => Promise<Record<string, unknown>>
    >
  >;
};

const stewardClient: StewardClientMock = {
  getAddresses: mock(async () => ({ addresses: [] })),
  getAgent: mock(async () => ({ walletAddress: null, walletAddresses: {} })),
  getBalance: mock(async () => ({
    balances: { native: "0", chainId: 56, symbol: "BNB" },
  })),
  getPolicies: mock(async () => []),
  setPolicies: mock(async () => undefined),
  getAgentDashboard: mock(async () => ({
    pendingApprovals: 0,
    recentTransactions: [],
  })),
  listPendingApprovals: mock(async () => []),
  listApprovals: mock(async () => []),
  approveTransaction: mock(async () => ({})),
  denyTransaction: mock(async () => ({})),
};

mock.module("@/db/helpers", () => ({
  dbWrite: { select: dbSelect },
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: { getAgent },
}));

mock.module("@/lib/services/steward-client", () => ({
  createStewardClient,
}));

mock.module("@/lib/services/proxy/cors", () => ({
  applyCorsHeaders: (response: Response) => response,
  handleCorsOptions: () => new Response(null, { status: 204 }),
}));

mock.module("@/lib/utils/logger", () => ({
  ...loggerActual,
  logger: {
    ...loggerActual.logger,
    info: loggerInfo,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

let routeModule: typeof import("../v1/eliza/agents/[agentId]/api/wallet/[...path]/route");

beforeAll(async () => {
  routeModule = await import(
    "../v1/eliza/agents/[agentId]/api/wallet/[...path]/route"
  );
});

afterEach(() => {
  dbRows.length = 0;
  dbLimit.mockClear();
  dbWhere.mockClear();
  dbFrom.mockClear();
  dbSelect.mockClear();
  requireUserOrApiKeyWithOrg.mockReset();
  getAgent.mockReset();
  createStewardClient.mockReset();
  loggerInfo.mockClear();
  for (const value of Object.values(stewardClient)) {
    value.mockClear();
  }
});

function mockContext(
  body?: unknown,
  options: { query?: string; authorization?: string } = {},
) {
  return {
    req: {
      url: `http://test.local/api/wallet/addresses${options.query ?? ""}`,
      header: (name: string) => {
        const normalized = name.toLowerCase();
        if (normalized === "content-type" && body) return "application/json";
        if (normalized === "authorization") return options.authorization;
        return undefined;
      },
      text: async () => (body ? JSON.stringify(body) : ""),
    },
  } as never;
}

async function callWallet(
  path: string,
  method: "GET" | "POST" | "PUT" = "GET",
  body?: unknown,
  options: { query?: string; authorization?: string } = {},
) {
  requireUserOrApiKeyWithOrg.mockResolvedValue({
    id: "user-1",
    organization_id: "org-1",
  });
  getAgent.mockResolvedValue({ id: "sandbox-agent-1" });
  createStewardClient.mockResolvedValue(stewardClient);
  return routeModule.handleDirectWalletRequest(
    mockContext(body, options),
    Promise.resolve({ agentId: "sandbox-agent-1", path: [path] }),
    method,
  );
}

describe("wallet proxy steward agent id resolution", () => {
  test("resolver returns the steward_agent_id for a sandbox agent", async () => {
    dbRows.push({ stewardAgentId: "cloud-client-address" });

    await expect(
      routeModule.resolveStewardAgentId("sandbox-agent-1", "org-1"),
    ).resolves.toBe("cloud-client-address");
    expect(dbSelect).toHaveBeenCalledTimes(1);
    expect(dbLimit).toHaveBeenCalledWith(1);
  });

  test("wallet calls use the resolved steward_agent_id", async () => {
    dbRows.push({ stewardAgentId: "cloud-client-address" });
    stewardClient.getAddresses.mockResolvedValue({
      addresses: [{ chainFamily: "evm", address: "0xwallet" }],
    });

    const response = await callWallet("addresses");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ evmAddress: "0xwallet", solanaAddress: "" });
    expect(stewardClient.getAddresses).toHaveBeenCalledWith(
      "cloud-client-address",
    );
  });

  test("balances emits the canonical WalletBalancesResponse DTO", async () => {
    dbRows.push({ stewardAgentId: "cloud-client-address" });
    stewardClient.getAddresses.mockResolvedValue({
      addresses: [{ chainFamily: "evm", address: "0xwallet" }],
    });
    stewardClient.getBalance.mockResolvedValue({
      walletAddress: "0xwallet",
      balances: {
        native: "1250000000000000000",
        nativeFormatted: "1.25",
        chainId: 56,
        symbol: "BNB",
      },
    });

    const response = await callWallet("balances");
    const body = (await response.json()) as WalletBalancesResponse;
    const expected = {
      evm: {
        address: "0xwallet",
        chains: [
          {
            chain: "BNB Smart Chain",
            chainId: 56,
            nativeBalance: "1.25",
            nativeSymbol: "BNB",
            nativeValueUsd: "0",
            tokens: [],
            error: "USD valuation is unavailable for this managed wallet",
          },
        ],
      },
      solana: null,
    } satisfies WalletBalancesResponse;

    expect(response.status).toBe(200);
    expect(body).toEqual(expected);
    expect(Array.isArray(body.evm?.chains)).toBe(true);
  });

  test("zero native balance is a canonical, fully-valued zero", async () => {
    dbRows.push({ stewardAgentId: "cloud-client-address" });
    stewardClient.getAddresses.mockResolvedValue({
      addresses: [{ chainFamily: "evm", address: "0xwallet" }],
    });
    stewardClient.getBalance.mockResolvedValue({
      walletAddress: "0xwallet",
      balances: {
        native: "0",
        nativeFormatted: "0",
        chainId: 8453,
        symbol: "ETH",
      },
    });

    const response = await callWallet("balances");
    const body = (await response.json()) as WalletBalancesResponse;

    expect(body.evm?.chains[0]).toMatchObject({
      chain: "Base",
      nativeBalance: "0",
      nativeValueUsd: "0",
      error: null,
    });
  });

  test("config reports managed addresses without inventing local credentials or Solana balance readiness", async () => {
    dbRows.push({ stewardAgentId: "cloud-client-address" });
    stewardClient.getAddresses.mockResolvedValue({
      addresses: [
        { chainFamily: "evm", address: "0xwallet" },
        { chainFamily: "solana", address: "So1wallet" },
      ],
    });

    const response = await callWallet("config");
    const body = (await response.json()) as WalletConfigStatus;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      evmAddress: "0xwallet",
      solanaAddress: "So1wallet",
      selectedRpcProviders: {
        evm: "eliza-cloud",
        bsc: "eliza-cloud",
        solana: "eliza-cloud",
      },
      alchemyKeySet: false,
      infuraKeySet: false,
      ankrKeySet: false,
      heliusKeySet: false,
      birdeyeKeySet: false,
      evmBalanceReady: true,
      solanaBalanceReady: false,
      walletSource: "managed",
      evmSigningCapability: "steward-cloud",
      solanaSigningAvailable: true,
    });
    expect(body.wallets).toEqual([
      {
        source: "cloud",
        chain: "evm",
        address: "0xwallet",
        provider: "steward",
        primary: true,
      },
      {
        source: "cloud",
        chain: "solana",
        address: "So1wallet",
        provider: "steward",
        primary: true,
      },
    ]);
  });

  test.each([
    ["nfts", "wallet_nfts_unavailable"],
    ["market-overview", "wallet_market_overview_unavailable"],
    ["trading-profile", "wallet_trading_profile_unavailable"],
  ])(
    "%s is an explicit optional capability, not a fake empty feed",
    async (path, code) => {
      const response = await callWallet(path);

      expect(response.status).toBe(501);
      await expect(response.json()).resolves.toMatchObject({
        success: false,
        code,
        capability: path,
      });
      expect(createStewardClient).not.toHaveBeenCalled();
    },
  );

  test("uses the only organization wallet as a safe fallback when sandbox mapping lookup is unavailable", async () => {
    dbRows.push({ stewardAgentId: "cloud-only-org-wallet" });
    dbLimit.mockImplementationOnce(async () => {
      throw new Error("column sandbox_agent_id does not exist");
    });
    stewardClient.getAddresses.mockResolvedValue({
      addresses: [{ chainFamily: "evm", address: "0xwallet" }],
    });

    const response = await callWallet("addresses");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ evmAddress: "0xwallet", solanaAddress: "" });
    expect(stewardClient.getAddresses).toHaveBeenCalledWith(
      "cloud-only-org-wallet",
    );
  });

  test("falls back to the sandbox UUID for legacy wallets without a mapping", async () => {
    stewardClient.getPolicies.mockResolvedValue([{ id: "p1" }]);

    const response = await callWallet("steward-policies");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual([{ id: "p1" }]);
    expect(stewardClient.getPolicies).toHaveBeenCalledWith("sandbox-agent-1");
    expect(loggerInfo).toHaveBeenCalledWith(
      "[wallet-api] No agent_server_wallets steward_agent_id mapping found; falling back to sandbox agent id",
      { sandboxAgentId: "sandbox-agent-1", orgId: "org-1" },
    );
  });

  test("returns 404 when no Steward-managed wallet exists for the sandbox agent", async () => {
    stewardClient.getAgent.mockRejectedValue(new Error("Agent not found"));

    const response = await callWallet("addresses");
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({
      error: "No Steward-managed wallet found for this agent",
    });
    expect(stewardClient.getAddresses).not.toHaveBeenCalled();
  });

  test("returns 404 before forwarding when the sandbox agent does not exist", async () => {
    requireUserOrApiKeyWithOrg.mockResolvedValue({
      id: "user-1",
      organization_id: "org-1",
    });
    getAgent.mockResolvedValue(null);

    const response = await routeModule.handleDirectWalletRequest(
      mockContext(),
      Promise.resolve({ agentId: "missing-agent", path: ["addresses"] }),
      "GET",
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({ success: false, error: "Agent not found" });
    expect(createStewardClient).not.toHaveBeenCalled();
  });

  test("pages pending approvals at the scoped Steward boundary and uses its authoritative total", async () => {
    dbRows.push({ stewardAgentId: "cloud-client-address" });
    const approvals = [
      {
        queueId: "approval-2",
        status: "pending",
        transaction: { id: "tx-2" },
      },
      {
        queueId: "approval-3",
        status: "pending",
        transaction: { id: "tx-3" },
      },
    ];
    stewardClient.listPendingApprovals.mockResolvedValue(approvals);
    stewardClient.getAgentDashboard.mockResolvedValue({
      pendingApprovals: 7,
      recentTransactions: [],
    });

    const response = await callWallet(
      "steward-pending-approvals",
      "GET",
      undefined,
      {
        query: "?limit=2&offset=1",
        authorization: "Bearer header.payload.signature",
      },
    );

    expect(response.status).toBe(200);
    const responseBody = await response.json();
    expect(responseBody).toEqual({
      approvals,
      total: 7,
      offset: 1,
      limit: 2,
    });
    expect(createStewardClient).toHaveBeenCalledWith({
      organizationId: "org-1",
      bearerToken: "header.payload.signature",
    });
    expect(stewardClient.listPendingApprovals).toHaveBeenCalledWith(
      "cloud-client-address",
      { limit: 2, offset: 1 },
    );
    expect(stewardClient.getAgentDashboard).toHaveBeenCalledWith(
      "cloud-client-address",
    );
    expect(stewardClient.listApprovals).not.toHaveBeenCalled();
  });

  test("does not fabricate a Steward session bearer for API-key requests", async () => {
    dbRows.push({ stewardAgentId: "cloud-client-address" });

    const response = await callWallet("steward-pending-approvals");

    expect(response.status).toBe(200);
    expect(createStewardClient).toHaveBeenCalledWith({
      organizationId: "org-1",
    });
  });

  test("fails closed when Steward returns an invalid pending approval total", async () => {
    dbRows.push({ stewardAgentId: "cloud-client-address" });
    stewardClient.getAgentDashboard.mockResolvedValue({
      pendingApprovals: -1,
      recentTransactions: [],
    });

    await expect(
      callWallet("steward-pending-approvals", "GET", undefined, {
        authorization: "Bearer header.payload.signature",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_STEWARD_PENDING_APPROVAL_TOTAL",
    });
  });
});
