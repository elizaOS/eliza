import { beforeEach, describe, expect, mock, test } from "bun:test";

const walletRecord = {
  id: "wallet-1",
  organization_id: "00000000-0000-4000-8000-0000000000aa",
  steward_tenant_id: "tenant-1",
  steward_agent_id: "steward-agent-1",
};

let capturedWhere: unknown;
const findFirst = mock(async (query: { where: unknown }) => {
  capturedWhere = query.where;
  return walletRecord;
});
const signMessage = mock(async () => ({ signature: "0xsigned" }));
const setIfNotExists = mock(async () => true);

mock.module("viem", () => ({
  verifyMessage: mock(async () => true),
}));

mock.module("../../../db/client", () => ({
  db: {
    query: {
      agentServerWallets: {
        findFirst,
      },
    },
  },
  dbRead: {},
  dbWrite: {},
  getDbConnectionInfo: () => ({
    url: "postgres://test",
    source: "test",
  }),
}));

mock.module("../../cache/client", () => ({
  cache: {
    setIfNotExists,
  },
}));

mock.module("../steward-client", () => ({
  createStewardClient: mock(async () => ({
    signMessage,
  })),
}));

const { executeServerWalletRpc } = await import("../server-wallets");

function containsValue(root: unknown, expected: string): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown): boolean => {
    if (value === expected) return true;
    if (typeof value === "string") return value.includes(expected);
    if (typeof value !== "object" || value === null || seen.has(value)) return false;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "string" && key.includes(expected)) return true;
      if (visit((value as Record<PropertyKey, unknown>)[key])) return true;
    }
    return false;
  };
  return visit(root);
}

beforeEach(() => {
  capturedWhere = undefined;
  findFirst.mockClear();
  signMessage.mockClear();
  setIfNotExists.mockClear();
});

describe("server wallet RPC lookup", () => {
  test("scopes wallet lookup to the authenticated organization", async () => {
    const organizationId = "00000000-0000-4000-8000-0000000000aa";

    await executeServerWalletRpc({
      clientAddress: "0x0000000000000000000000000000000000000001",
      organizationId,
      payload: {
        method: "personal_sign",
        params: ["hello"],
        timestamp: Date.now(),
        nonce: "nonce-1",
      },
      signature: "0xsignature",
    });

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(containsValue(capturedWhere, "organization_id")).toBe(true);
    expect(containsValue(capturedWhere, "client_address")).toBe(true);
    expect(signMessage).toHaveBeenCalledWith("steward-agent-1", "hello");
  });
});
