// Exercises server wallets behavior with deterministic cloud-shared lib fixtures.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.TEST_DATABASE_URL ||= "pglite://memory";

const realClient = await import("../../../db/client");

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
const dbQueryMock = new Proxy(
  (realClient.db as unknown as { query?: Record<PropertyKey, unknown> }).query ?? {},
  {
    get(target, prop, receiver) {
      if (prop === "agentServerWallets") return { findFirst };
      return Reflect.get(target, prop, receiver);
    },
  },
);
const dbMock = new Proxy(realClient.db as Record<PropertyKey, unknown>, {
  get(target, prop, receiver) {
    if (prop === "query") return dbQueryMock;
    return Reflect.get(target, prop, receiver);
  },
});

mock.module("viem", () => ({
  verifyMessage: mock(async () => true),
}));

mock.module("../../../db/client", () => ({
  ...realClient,
  db: dbMock,
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

beforeEach(() => {
  capturedWhere = undefined;
  findFirst.mockClear();
  signMessage.mockClear();
  setIfNotExists.mockClear();
});

describe("server wallet RPC lookup", () => {
  test("looks the wallet up globally by client_address + EVM chain, not org-scoped", async () => {
    await executeServerWalletRpc({
      clientAddress: "0x0000000000000000000000000000000000000001",
      payload: {
        method: "personal_sign",
        params: ["hello"],
        timestamp: Date.now(),
        nonce: "nonce-1",
      },
      signature: "0xsignature",
    });

    expect(findFirst).toHaveBeenCalledTimes(1);
    // Render the WHERE to SQL — walking the object graph is unreliable because a
    // column back-references its table (which exposes every column name).
    const sql = new PgDialect().sqlToQuery(capturedWhere as SQL).sql;
    expect(sql).toContain("client_address");
    expect(sql).toContain("chain_type");
    // Must NOT org-scope: provision stores the row under the API-key owner's
    // org, the RPC signer resolves to a separate wallet-derived org, so an
    // org-scoped lookup would 404 every legitimate call (#10279). client_address
    // + chain_type is globally unique (proof-of-control at provision), so this
    // is unambiguous while still supporting separate EVM and Solana wallets.
    expect(sql).not.toContain("organization_id");
    expect(signMessage).toHaveBeenCalledWith("steward-agent-1", "hello");
  });
});
