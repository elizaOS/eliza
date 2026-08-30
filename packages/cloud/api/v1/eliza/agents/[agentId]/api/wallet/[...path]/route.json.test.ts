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
const stewardGetAgent = mock(async () => ({
  walletAddress: "0x1",
  walletAddresses: {},
}));
const createStewardClient = mock(async () => ({
  getAddresses: async () => ({ addresses: [] }),
  getAgent: stewardGetAgent,
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
const { personalSharedAgentId } = await import(
  "@/lib/services/shared-runtime/personal-shared-agent"
);

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

  test("canonical Personal id bypasses UUID-backed sandbox and wallet repositories", async () => {
    getAgent.mockClear();
    dbSelect.mockClear();
    const personalId = personalSharedAgentId({
      userId: "user-1",
      organizationId: "org-1",
    });

    const response = await handleDirectWalletRequest(
      context(""),
      Promise.resolve({ agentId: personalId, path: ["addresses"] }),
      "GET",
    );

    expect(response.status).toBe(200);
    expect(getAgent).not.toHaveBeenCalled();
    expect(dbSelect).not.toHaveBeenCalled();
  });

  test("canonical Personal id is normalized before Steward lookup", async () => {
    stewardGetAgent.mockClear();
    const personalId = personalSharedAgentId({
      userId: "user-1",
      organizationId: "org-1",
    });

    const response = await handleDirectWalletRequest(
      context(""),
      Promise.resolve({
        agentId: personalId.toUpperCase(),
        path: ["addresses"],
      }),
      "GET",
    );

    expect(response.status).toBe(200);
    expect(stewardGetAgent).toHaveBeenCalledWith(personalId);
  });

  test("canonical Personal id without a Steward agent returns the existing typed 404", async () => {
    getAgent.mockClear();
    dbSelect.mockClear();
    stewardGetAgent.mockImplementationOnce(async () => {
      throw new Error("Steward agent unavailable");
    });
    const personalId = personalSharedAgentId({
      userId: "user-1",
      organizationId: "org-1",
    });

    const response = await handleDirectWalletRequest(
      context(""),
      Promise.resolve({ agentId: personalId, path: ["addresses"] }),
      "GET",
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "No Steward-managed wallet found for this agent",
    });
    expect(getAgent).not.toHaveBeenCalled();
    expect(dbSelect).not.toHaveBeenCalled();
  });

  test("cross-user Personal id is indistinguishable from a missing agent", async () => {
    getAgent.mockClear();
    dbSelect.mockClear();
    createStewardClient.mockClear();
    const otherAccountId = personalSharedAgentId({
      userId: "other-user",
      organizationId: "org-1",
    });

    const response = await handleDirectWalletRequest(
      context(""),
      Promise.resolve({ agentId: otherAccountId, path: ["addresses"] }),
      "GET",
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Agent not found",
    });
    expect(getAgent).not.toHaveBeenCalled();
    expect(dbSelect).not.toHaveBeenCalled();
    expect(createStewardClient).not.toHaveBeenCalled();
  });

  test("cross-organization Personal id is indistinguishable from a missing agent", async () => {
    getAgent.mockClear();
    dbSelect.mockClear();
    const otherOrganizationId = personalSharedAgentId({
      userId: "user-1",
      organizationId: "other-org",
    });

    const response = await handleDirectWalletRequest(
      context(""),
      Promise.resolve({ agentId: otherOrganizationId, path: ["addresses"] }),
      "GET",
    );

    expect(response.status).toBe(404);
    expect(getAgent).not.toHaveBeenCalled();
    expect(dbSelect).not.toHaveBeenCalled();
  });

  test("normal sandbox id keeps the organization-scoped sandbox lookup", async () => {
    getAgent.mockClear();

    const response = await handleDirectWalletRequest(
      context(""),
      Promise.resolve({ agentId: "sandbox-agent-1", path: ["addresses"] }),
      "GET",
    );

    expect(response.status).toBe(200);
    expect(getAgent).toHaveBeenCalledWith("sandbox-agent-1", "org-1");
  });

  test("canonical Personal optional wallet response remains capability-specific", async () => {
    getAgent.mockClear();
    createStewardClient.mockClear();
    const personalId = personalSharedAgentId({
      userId: "user-1",
      organizationId: "org-1",
    });

    const response = await handleDirectWalletRequest(
      context(""),
      Promise.resolve({ agentId: personalId, path: ["nfts"] }),
      "GET",
    );

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: "wallet_nfts_unavailable",
      capability: "nfts",
    });
    expect(getAgent).not.toHaveBeenCalled();
    expect(createStewardClient).not.toHaveBeenCalled();
  });
});
