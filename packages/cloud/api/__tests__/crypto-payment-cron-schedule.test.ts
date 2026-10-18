/**
 * The per-minute Worker cron must reach the direct-crypto recovery route: it
 * is the only caller that auto-confirms a payment left in `broadcast` (the
 * payer's confirm call never landed) and retries pending treasury sweeps.
 * The real scheduled() dispatcher calls the real route with the cron secret;
 * only the payment service is replaced.
 */
import { expect, mock, test } from "bun:test";
import { Hono } from "hono";

const calls: string[] = [];
mock.module(
  "@elizaos/cloud-shared/lib/services/direct-wallet-payments",
  () => ({
    directWalletPaymentsService: {
      processBroadcastBatch: async () => {
        calls.push("processBroadcastBatch");
        return { processed: 0, confirmed: 0, stillPending: 0, failed: 0 };
      },
      drainSweepOutbox: async () => {
        calls.push("drainSweepOutbox");
        return { processed: 0, delivered: 0, deferred: 0 };
      },
    },
  }),
);

const { makeCronHandler } = await import("../src/cron");
const route = (await import("../cron/process-pending-crypto-payments/route"))
  .default;

test("the every-minute cron runs the crypto payment recovery", async () => {
  const app = new Hono();
  app.route("/api/cron/process-pending-crypto-payments", route);
  const reached: Array<{ path: string; status: number }> = [];
  const appFetch = async (request: Request, env: never, ctx: never) => {
    const path = new URL(request.url).pathname;
    if (path !== "/api/cron/process-pending-crypto-payments") {
      return new Response(null, { status: 204 });
    }
    const response = await app.fetch(request, env, ctx);
    reached.push({ path, status: response.status });
    return response;
  };
  const pending: Promise<unknown>[] = [];
  await makeCronHandler(appFetch as never)(
    {
      cron: "* * * * *",
      scheduledTime: Date.now(),
      noRetry: () => {},
    } as never,
    {
      CRON_SECRET: "cron-test-secret",
      NEXT_PUBLIC_APP_URL: "http://internal",
    } as never,
    {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    } as never,
  );
  await Promise.allSettled(pending);

  expect(reached).toEqual([
    { path: "/api/cron/process-pending-crypto-payments", status: 200 },
  ]);
  expect(calls.sort()).toEqual(["drainSweepOutbox", "processBroadcastBatch"]);
});
