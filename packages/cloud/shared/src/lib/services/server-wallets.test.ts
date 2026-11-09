/**
 * Server-wallet RPC replay protection: the timestamp window is symmetric, and
 * the nonce claim goes through the atomic single-use record store (the
 * authentication state Durable Object when the cache is KV), so one signed
 * request reaches Steward at most once.
 */
import { afterAll, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { cache } from "../cache/client";
import { runWithCloudBindingsAsync } from "../runtime/cloud-bindings";

const signTransaction = mock(async () => ({ hash: "0xsigned" }));

mock.module("../../db/client", () => ({
  db: {
    query: {
      agentServerWallets: {
        findFirst: async () => ({
          id: "wallet-1",
          organization_id: "org-1",
          steward_tenant_id: "tenant-1",
          steward_agent_id: "agent-1",
        }),
      },
    },
  },
}));

mock.module("./steward-client", () => ({
  createStewardClient: async () => ({ signTransaction }),
}));

mock.module("./steward-tenant-config", () => ({
  ensureStewardTenant: async () => {
    throw new Error("provisioning is not reached in this test");
  },
}));

const { executeServerWalletRpc } = await import("./server-wallets");

/** In-memory stand-in for the AUTHENTICATION_STATE Durable Object shards. */
function fakeAuthenticationState() {
  const records = new Map<string, number>();
  return {
    getByName: () => ({
      fetch: async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as {
          key: string;
          operation: string;
          seconds?: number;
          nx?: boolean;
        };
        // Yield first so concurrent callers interleave as they would over the wire.
        await Promise.resolve();
        const expiresAt = records.get(body.key);
        const live = expiresAt !== undefined && expiresAt > Date.now();
        if (body.operation === "set") {
          if (body.nx && live) return Response.json({ value: null });
          records.set(body.key, Date.now() + (body.seconds ?? 0) * 1000);
          return Response.json({ value: "OK" });
        }
        return Response.json({ value: live ? "1" : null });
      },
    }),
  };
}

const account = privateKeyToAccount(generatePrivateKey());

async function signedRpc(timestamp: number, nonce: string) {
  const payload = {
    method: "eth_sendTransaction",
    params: [{ to: "0x000000000000000000000000000000000000dEaD", value: "1" }],
    timestamp,
    nonce,
  };
  const signature = await account.signMessage({ message: JSON.stringify(payload) });
  return { clientAddress: account.address, payload, signature };
}

function withStore<T>(namespace: unknown, fn: () => Promise<T>): Promise<T> {
  return runWithCloudBindingsAsync(
    { CLOUD_AUTH_STATE_BACKEND: "cloudflare", AUTHENTICATION_STATE: namespace },
    fn,
  );
}

beforeAll(() => {
  spyOn(cache, "supportsAtomicOperations").mockReturnValue(false);
  spyOn(cache, "setIfNotExists").mockImplementation(async () => {
    throw new Error("the racy KV path must not be used for nonces");
  });
});

afterAll(() => {
  mock.restore();
});

test("a timestamp more than 5 minutes ahead of server time is rejected", async () => {
  const request = await signedRpc(Date.now() + 6 * 60 * 1000, "future-nonce");
  await expect(
    withStore(fakeAuthenticationState(), () => executeServerWalletRpc(request)),
  ).rejects.toThrow("RPC request expired");
  expect(signTransaction).not.toHaveBeenCalled();
});

test("two concurrent requests with one nonce: only one reaches Steward", async () => {
  signTransaction.mockClear();
  const request = await signedRpc(Date.now(), "shared-nonce");
  const results = await withStore(fakeAuthenticationState(), () =>
    Promise.allSettled([executeServerWalletRpc(request), executeServerWalletRpc(request)]),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  expect(rejected.reason.message).toContain("RPC nonce already used");
  expect(signTransaction).toHaveBeenCalledTimes(1);
});
