/** Pins cron authentication and canonical payment-request expiry dispatch. */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const expirePast = mock(async () => ["pr-1", "pr-2"]);
const dispatchPaymentCallbacks = mock(async () => ({
  claimed: 2,
  dispatched: 1,
  failed: 1,
}));

const { createPaymentRequestCronApp } = await import("./route");
const app = createPaymentRequestCronApp({
  paymentRequests: () => ({ expirePast }),
  dispatchCallbacks: dispatchPaymentCallbacks,
});
const ENV = { CRON_SECRET: "cron-secret" } as Record<string, string>;

function call(secret?: string, env: Record<string, string> = ENV) {
  return app.fetch(
    new Request("https://api.example.test/", {
      method: "POST",
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    }),
    env,
  );
}

describe("cleanup-expired-payment-requests cron route", () => {
  beforeEach(() => {
    expirePast.mockClear();
    dispatchPaymentCallbacks.mockClear();
  });

  test("requires a configured matching cron secret", async () => {
    expect((await call("cron-secret", {})).status).toBe(403);
    expect((await call("wrong")).status).toBe(401);
    expect(expirePast).not.toHaveBeenCalled();
  });

  test("runs the global canonical sweep exactly once", async () => {
    const response = await call("cron-secret");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      expiredCount: 2,
      callbacks: { claimed: 2, dispatched: 1, failed: 1 },
    });
    expect(expirePast).toHaveBeenCalledTimes(1);
    expect(dispatchPaymentCallbacks).toHaveBeenCalledWith({ limit: 50 });
  });
});
