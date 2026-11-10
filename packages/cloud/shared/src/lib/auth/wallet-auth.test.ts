/**
 * Wallet-header replay nonces on a Worker: the cache there is Cloudflare KV,
 * whose set-if-not-exists is get-then-put, so the nonce must go through the
 * authentication state store, and it must outlive a future-dated signature.
 */
import { afterAll, afterEach, beforeAll, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { cache } from "../cache/client";
import { runWithCloudBindingsAsync } from "../runtime/cloud-bindings";

mock.module("../services/wallet-signup", () => ({
  findOrCreateUserByWalletAddress: async () => {
    throw new Error("wallet signup is not reached in this test");
  },
}));

const { verifyWalletSignature } = await import("./wallet-auth");

/** In-memory stand-in for the AUTHENTICATION_STATE Durable Object shards. */
function fakeAuthenticationState() {
  const records = new Map<string, { value: string; expiresAt: number }>();
  const writes: Array<{ key: string; seconds: number }> = [];
  const namespace = {
    getByName: () => ({
      fetch: async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as {
          key: string;
          operation: string;
          value?: string;
          seconds?: number;
          nx?: boolean;
        };
        // Yield first so concurrent callers interleave as they would over the wire.
        await Promise.resolve();
        const existing = records.get(body.key);
        const live = existing && existing.expiresAt > Date.now() ? existing : undefined;
        if (body.operation === "set") {
          if (body.nx && live) return Response.json({ value: null });
          writes.push({ key: body.key, seconds: body.seconds ?? 0 });
          records.set(body.key, {
            value: body.value ?? "",
            expiresAt: Date.now() + (body.seconds ?? 0) * 1000,
          });
          return Response.json({ value: "OK" });
        }
        if (body.operation === "getdel") records.delete(body.key);
        return Response.json({ value: live?.value ?? null });
      },
    }),
  };
  return { namespace, writes };
}

const account = privateKeyToAccount(generatePrivateKey());

async function signedRequest(timestamp: number): Promise<Request> {
  const message = `Eliza Cloud Authentication\nTimestamp: ${timestamp}\nMethod: GET\nPath: /api/v1/user`;
  return new Request("https://cloud.test/api/v1/user", {
    headers: {
      "X-Wallet-Address": account.address,
      "X-Timestamp": String(timestamp),
      "X-Wallet-Signature": await account.signMessage({ message }),
    },
  });
}

const activeUser = { is_active: true, organization: { is_active: true } };

beforeAll(() => {
  spyOn(cache, "supportsAtomicOperations").mockReturnValue(false);
  spyOn(cache, "get").mockResolvedValue(activeUser as never);
  spyOn(cache, "setIfNotExists").mockImplementation(async () => {
    throw new Error("the racy KV path must not be used for nonces");
  });
});

afterEach(() => {
  setSystemTime();
});

afterAll(() => {
  mock.restore();
});

function withStore<T>(namespace: unknown, fn: () => Promise<T>): Promise<T> {
  return runWithCloudBindingsAsync(
    { CLOUD_AUTH_STATE_BACKEND: "cloudflare", AUTHENTICATION_STATE: namespace },
    fn,
  );
}

test("two concurrent uses of one nonce: only one succeeds", async () => {
  const { namespace } = fakeAuthenticationState();
  const timestamp = Date.now();
  const results = await withStore(namespace, async () =>
    Promise.allSettled([
      verifyWalletSignature(await signedRequest(timestamp)),
      verifyWalletSignature(await signedRequest(timestamp)),
    ]),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((r) => r.status === "rejected");
  expect(rejected && (rejected as PromiseRejectedResult).reason.message).toBe(
    "Signature has already been used",
  );
});

test("a nonce with a timestamp 4 minutes ahead stays used until its window closes", async () => {
  const { namespace, writes } = fakeAuthenticationState();
  const start = Date.now();
  const timestamp = start + 4 * 60 * 1000;
  const request = await signedRequest(timestamp);

  await withStore(namespace, () => verifyWalletSignature(request.clone()));
  // The signature is accepted until timestamp + 5 min = start + 9 min.
  expect(writes[0].seconds * 1000).toBeGreaterThanOrEqual(9 * 60 * 1000);

  setSystemTime(new Date(start + 6 * 60 * 1000));
  await expect(withStore(namespace, () => verifyWalletSignature(request.clone()))).rejects.toThrow(
    "Signature has already been used",
  );
});
