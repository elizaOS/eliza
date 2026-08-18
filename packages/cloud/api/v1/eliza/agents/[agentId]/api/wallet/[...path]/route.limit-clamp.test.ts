/**
 * GET .../wallet/steward-tx-records previously parsed `limit`/`offset` with
 * `Number(params.get(name) ?? fallback)` + `Math.trunc` + min/max clamp, which
 * accepted scientific notation ("1e4"), hex ("0x10"), fractional ("5.9"), and
 * negative values as valid numbers instead of rejecting them. This drives the
 * real GET handler (not the implementation source) and asserts the exact
 * `limit`/`offset` echoed back in the response, which the route itself uses to
 * slice `records`.
 */
import { describe, expect, mock, test } from "bun:test";

mock.module("@elizaos/plugin-todos/edge", () => ({
  convergeTodoScopesInTransaction: async () => undefined,
}));

const dbLimit = mock(async () => []);
const dbWhere = mock(() => ({ limit: dbLimit }));
const dbFrom = mock(() => ({ where: dbWhere }));
const dbSelect = mock(() => ({ from: dbFrom }));
const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
}));
const getAgent = mock(async () => ({ id: "sandbox-agent-1" }));
const listPendingApprovals = mock(async () => []);

mock.module("@/db/helpers", () => ({
  dbWrite: { select: dbSelect },
}));
mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
  readSessionCredential: () => undefined,
}));
mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: { getAgent },
}));
mock.module("@/lib/services/steward-client", () => ({
  createStewardClient: async () => ({
    getAddresses: async () => ({ addresses: [] }),
    getAgent: async () => ({ walletAddress: "0x1", walletAddresses: {} }),
    getBalance: async () => ({
      balances: { native: "0", chainId: 56, symbol: "BNB" },
    }),
    getPolicies: async () => [],
    setPolicies: async () => undefined,
    getAgentDashboard: async () => ({
      pendingApprovals: 0,
      recentTransactions: [],
    }),
    listPendingApprovals,
    listApprovals: async () => [],
    approveTransaction: async () => ({ ok: true, txId: "tx-1" }),
    denyTransaction: async () => ({}),
  }),
}));
mock.module("@/lib/services/proxy/cors", () => ({
  applyCorsHeaders: (response: Response) => response,
  handleCorsOptions: () => new Response(null, { status: 204 }),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

const { handleDirectWalletRequest } = await import("./route");

function context(path: string, query: string) {
  return {
    req: {
      url: `http://test.local/api/wallet/${path}${query}`,
    },
    json: (body: unknown, status?: number) =>
      Response.json(body, { status: status ?? 200 }),
  } as never;
}

async function txRecords(query: string) {
  const response = await handleDirectWalletRequest(
    context("steward-tx-records", query),
    Promise.resolve({
      agentId: "sandbox-agent-1",
      path: ["steward-tx-records"],
    }),
    "GET",
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { limit: number; offset: number };
}

async function pendingApprovals(query: string) {
  listPendingApprovals.mockClear();
  const response = await handleDirectWalletRequest(
    context("steward-pending-approvals", query),
    Promise.resolve({
      agentId: "sandbox-agent-1",
      path: ["steward-pending-approvals"],
    }),
    "GET",
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { limit: number; offset: number };
}

describe("GET steward-tx-records limit/offset clamp", () => {
  test("defaults to limit=50 offset=0 when absent", async () => {
    const body = await txRecords("");
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  test("accepts a valid in-range limit/offset", async () => {
    const body = await txRecords("?limit=7&offset=3");
    expect(body.limit).toBe(7);
    expect(body.offset).toBe(3);
  });

  test("clamps an over-limit request to the max of 100", async () => {
    const body = await txRecords("?limit=999999");
    expect(body.limit).toBe(100);
  });

  test.each(["1e4", "0x10", "5.9", "-5", "5junk", "Infinity", "NaN"])(
    "falls back to the default limit for malformed limit=%s",
    async (malformed) => {
      const body = await txRecords(`?limit=${encodeURIComponent(malformed)}`);
      expect(body.limit).toBe(50);
    },
  );

  test.each(["1e4", "0x10", "5.9", "-5", "5junk"])(
    "falls back to the default offset for malformed offset=%s",
    async (malformed) => {
      const body = await txRecords(`?offset=${encodeURIComponent(malformed)}`);
      expect(body.offset).toBe(0);
    },
  );

  test("whitespace-padded values are rejected like every other malformed input", async () => {
    const body = await txRecords("?limit=%207%20&offset=%203%20");
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  test("unsafe-integer offset falls back to the default", async () => {
    const body = await txRecords("?offset=99999999999999999999999");
    expect(body.offset).toBe(0);
  });
});

describe("GET steward-pending-approvals limit/offset clamp", () => {
  test("passes canonical values to Steward and echoes them in the response", async () => {
    const body = await pendingApprovals("?limit=7&offset=3");

    expect(listPendingApprovals).toHaveBeenCalledWith("sandbox-agent-1", {
      limit: 7,
      offset: 3,
    });
    expect(body).toMatchObject({ limit: 7, offset: 3 });
  });

  test("does not forward malformed values to Steward", async () => {
    const body = await pendingApprovals("?limit=1e2&offset=-5");

    expect(listPendingApprovals).toHaveBeenCalledWith("sandbox-agent-1", {
      limit: 50,
      offset: 0,
    });
    expect(body).toMatchObject({ limit: 50, offset: 0 });
  });
});
