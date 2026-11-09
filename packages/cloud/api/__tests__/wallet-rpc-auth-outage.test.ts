/**
 * POST /api/v1/user/wallets/rpc while the wallet-auth nonce store is down must
 * answer 503 with Retry-After, not the 401 an invalid signature gets, so a
 * correctly signing client retries instead of treating its key as bad.
 */
import { afterAll, expect, test } from "bun:test";

process.env.NODE_ENV = "test";

const { cache } = await import("@elizaos/cloud-shared/lib/cache/client");
const { Hono } = await import("hono");
const { default: route } = await import("../v1/user/wallets/rpc/route");

const app = new Hono();
app.route("/api/v1/user/wallets/rpc", route);

const realIsAvailable = cache.isAvailable;
afterAll(() => {
  cache.isAvailable = realIsAvailable;
});

test("a wallet auth store outage is a retryable 503", async () => {
  cache.isAvailable = () => false;
  const address = "0x52908400098527886E0F7030069857D2E4169EE7";
  const res = await app.request(
    "/api/v1/user/wallets/rpc",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Wallet-Address": address,
        "X-Timestamp": String(Date.now()),
        "X-Wallet-Signature": "0x00",
      },
      body: JSON.stringify({
        clientAddress: address,
        payload: { method: "eth_chainId", params: [] },
        signature: "0x00",
        timestamp: Date.now(),
        nonce: "n-1",
      }),
    },
    { NODE_ENV: "test", RATE_LIMIT_DISABLED: "true" },
  );
  expect(res.status).toBe(503);
  expect(res.headers.get("Retry-After")).toBe("30");
  expect(await res.json()).toMatchObject({
    success: false,
    code: "service_unavailable",
  });
});
