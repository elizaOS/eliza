// Exercises cloud API tests wallet proxy steward agent id.test behavior with deterministic Worker route fixtures.
import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
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
        balances: { native: string; chainId: number; symbol: string };
      }>
    >
  >;
  getPolicies: ReturnType<typeof mock<(agentId: string) => Promise<unknown[]>>>;
  setPolicies: ReturnType<
    typeof mock<(agentId: string, policies: unknown[]) => Promise<void>>
  >;
  getAgentDashboard: ReturnType<
    typeof mock<(agentId: string) => Promise<{ recentTransactions: unknown[] }>>
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
  getAgentDashboard: mock(async () => ({ recentTransactions: [] })),
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

function mockContext(body?: unknown) {
  return {
    req: {
      url: "http://test.local/api/wallet/addresses",
      header: (name: string) =>
        name.toLowerCase() === "content-type" && body
          ? "application/json"
          : undefined,
      text: async () => (body ? JSON.stringify(body) : ""),
    },
  } as never;
}

async function callWallet(
  path: string,
  method: "GET" | "POST" | "PUT" = "GET",
  body?: unknown,
) {
  requireUserOrApiKeyWithOrg.mockResolvedValue({
    id: "user-1",
    organization_id: "org-1",
  });
  getAgent.mockResolvedValue({ id: "sandbox-agent-1" });
  createStewardClient.mockResolvedValue(stewardClient);
  return routeModule.handleDirectWalletRequest(
    mockContext(body),
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
});

describe("steward-pending-approvals agent-scoped pagination (#19099)", () => {
  type ApprovalRow = { agentId?: string } & Record<string, unknown>;

  /** A global pending list interleaving this agent's rows with others'. */
  function globalList(mineCount: number, othersPerMine: number): ApprovalRow[] {
    const rows: ApprovalRow[] = [];
    for (let i = 0; i < mineCount; i++) {
      for (let o = 0; o < othersPerMine; o++) {
        rows.push({ agentId: "other-agent", txId: `other-${i}-${o}` });
      }
      rows.push({
        agentId: "cloud-client-address",
        txId: `mine-${String(i).padStart(3, "0")}`,
      });
    }
    return rows;
  }

  /** callWallet embeds the path only; approvals params ride on the req URL. */
  async function callApprovals(query: string) {
    requireUserOrApiKeyWithOrg.mockResolvedValue({
      id: "user-1",
      organization_id: "org-1",
    });
    getAgent.mockResolvedValue({ id: "sandbox-agent-1" });
    createStewardClient.mockResolvedValue(stewardClient);
    const context = {
      req: {
        url: `http://test.local/api/wallet/steward-pending-approvals${query}`,
        header: () => undefined,
        text: async () => "",
      },
    } as never;
    return routeModule.handleDirectWalletRequest(
      context,
      Promise.resolve({
        agentId: "sandbox-agent-1",
        path: ["steward-pending-approvals"],
      }),
      "GET",
    );
  }

  function serveGlobalList(rows: ApprovalRow[]) {
    stewardClient.listApprovals.mockImplementation(async (opts?: unknown) => {
      const { limit = 50, offset = 0 } = (opts ?? {}) as {
        limit?: number;
        offset?: number;
      };
      return rows.slice(offset, offset + limit);
    });
  }

  test("a page filled with other agents' rows still returns this agent's approvals", async () => {
    dbRows.push({ stewardAgentId: "cloud-client-address" });
    // 5 of ours, each preceded by 30 others: ours all sit beyond the first
    // source window, where the old slice-then-filter returned [].
    serveGlobalList(globalList(5, 30));

    const res = await callApprovals("?limit=5&offset=0");
    const body = (await res.json()) as {
      approvals: Array<{ txId: string }>;
      total: number;
    };

    expect(body.approvals.map((a) => a.txId)).toEqual([
      "mine-000",
      "mine-001",
      "mine-002",
      "mine-003",
      "mine-004",
    ]);
    expect(body.total).toBe(5);
  });

  test("offset pages through this agent's list, not the global list", async () => {
    dbRows.push({ stewardAgentId: "cloud-client-address" });
    serveGlobalList(globalList(12, 4));

    const first = (await (await callApprovals("?limit=5&offset=0")).json()) as {
      approvals: Array<{ txId: string }>;
      total: number;
    };
    const second = (await (
      await callApprovals("?limit=5&offset=5")
    ).json()) as { approvals: Array<{ txId: string }>; total: number };

    expect(first.approvals.map((a) => a.txId)).toEqual([
      "mine-000",
      "mine-001",
      "mine-002",
      "mine-003",
      "mine-004",
    ]);
    expect(second.approvals.map((a) => a.txId)).toEqual([
      "mine-005",
      "mine-006",
      "mine-007",
      "mine-008",
      "mine-009",
    ]);
    // total advances past the requested page so clients keep paging.
    expect(second.total).toBeGreaterThan(10);
  });

  test("total is the agent's full pending count when the source is exhausted", async () => {
    dbRows.push({ stewardAgentId: "cloud-client-address" });
    serveGlobalList(globalList(7, 2));

    const res = await callApprovals("?limit=50&offset=0");
    const body = (await res.json()) as {
      approvals: Array<{ txId: string }>;
      total: number;
    };

    expect(body.approvals).toHaveLength(7);
    expect(body.total).toBe(7);
  });

  test("an agent with no pending approvals gets an empty page, not others' rows", async () => {
    dbRows.push({ stewardAgentId: "cloud-client-address" });
    serveGlobalList(
      Array.from({ length: 40 }, (_, i) => ({
        agentId: "other-agent",
        txId: `other-${i}`,
      })),
    );

    const res = await callApprovals("?limit=5&offset=0");
    const body = (await res.json()) as { approvals: unknown[]; total: number };

    expect(body.approvals).toEqual([]);
    expect(body.total).toBe(0);
  });
});
