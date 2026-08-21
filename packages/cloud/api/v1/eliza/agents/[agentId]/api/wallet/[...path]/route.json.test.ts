/** Verifies wallet proxy JSON parsing with deterministic identity and Steward mocks. */
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
const approveTransaction = mock(async () => ({ ok: true, txId: "tx-1" }));
const denyTransaction = mock(async () => ({}));
const setPolicies = mock(async () => undefined);
const createStewardClient = mock(async () => ({
  getAddresses: async () => ({ addresses: [] }),
  getAgent: async () => ({ walletAddress: "0x1", walletAddresses: {} }),
  getBalance: async () => ({
    balances: { native: "0", chainId: 56, symbol: "BNB" },
  }),
  getPolicies: async () => [],
  setPolicies,
  getAgentDashboard: async () => ({
    pendingApprovals: 0,
    recentTransactions: [],
  }),
  listPendingApprovals: async () => [],
  listApprovals: async () => [],
  approveTransaction,
  denyTransaction,
}));

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
  createStewardClient,
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

function context(bodyText: string) {
  return {
    req: {
      url: "http://test.local/api/wallet/steward-approve-tx",
      header: (name: string) =>
        name.toLowerCase() === "content-type" ? "application/json" : undefined,
      text: async () => bodyText,
    },
    json: (body: unknown, status?: number) =>
      Response.json(body, { status: status ?? 200 }),
  } as never;
}

describe("wallet-path malformed JSON", () => {
  test.each([
    ["POST", "steward-approve-tx", approveTransaction],
    ["POST", "steward-deny-tx", denyTransaction],
    ["PUT", "steward-policies", setPolicies],
  ] as const)(
    "%s %s returns 400 before mutation",
    async (method, path, mutation) => {
      const response = await handleDirectWalletRequest(
        context("{"),
        Promise.resolve({
          agentId: "sandbox-agent-1",
          path: [path],
        }),
        method,
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: "Invalid JSON body",
      });
      expect(mutation).not.toHaveBeenCalled();
    },
  );

  test("canonical JSON still approves the transaction", async () => {
    const response = await handleDirectWalletRequest(
      context(JSON.stringify({ txId: "tx-1" })),
      Promise.resolve({
        agentId: "sandbox-agent-1",
        path: ["steward-approve-tx"],
      }),
      "POST",
    );
    expect(response.status).toBe(200);
    expect(approveTransaction).toHaveBeenCalled();
  });
});
