/** Pins cron authentication and canonical payment-request expiry dispatch. */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const expirePast = mock(async () => ["pr-1", "pr-2"]);

mock.module("@/lib/services/payment-requests-default", () => ({
  getPaymentRequestsService: () => ({ expirePast }),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(), info: mock(), warn: mock() },
}));

const { default: app } = await import("./route");
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
  beforeEach(() => expirePast.mockClear());

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
    });
    expect(expirePast).toHaveBeenCalledTimes(1);
  });
});
