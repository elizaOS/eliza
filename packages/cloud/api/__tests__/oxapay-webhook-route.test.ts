// Exercises cloud API tests oxapay webhook route.test behavior with deterministic Worker route fixtures.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import type { PaymentCallbackEvent } from "@/lib/services/payment-callback-bus";
// Subscribe on the REAL bus (rather than mock.module'ing it) — a module mock
// here is process-global and would swap the singleton out from under any later
// suite that publishes/waits on payment callbacks.
import { paymentCallbackBus } from "@/lib/services/payment-callback-bus";
// Spread into the partial logger mock below — mock.module is process-global,
// so dropping the real `redact` export breaks later suites that import it.
import * as loggerActual from "@/lib/utils/logger";

const SECRET = "test-oxapay-webhook-secret";

const markSettled = mock(async () => ({ id: "row" }));
const markFailed = mock(async () => ({ id: "row" }));

mock.module("@/lib/services/payment-requests-default", () => ({
  getPaymentRequestsService: () => ({ markSettled, markFailed }),
  paymentRequestsService: { markSettled, markFailed },
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: {
    AGGRESSIVE: "aggressive",
    CRITICAL: "critical",
    STANDARD: "standard",
    STRICT: "strict",
  },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

mock.module("@/lib/utils/logger", () => ({
  ...loggerActual,
  logger: {
    ...loggerActual.logger,
    debug: mock(),
    error: mock(),
    info: mock(),
    warn: mock(),
  },
}));

const { default: app } = await import("../v1/oxapay/webhook/route");

async function sign(body: string, secret: string = SECRET): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function oxaPayRequest(
  body: string,
  headers: Record<string, string> = {},
): Request {
  return new Request("https://api.example.test/", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

const env = {};

let busEvents: PaymentCallbackEvent[] = [];
let unsubscribe: (() => void) | null = null;

beforeAll(() => {
  process.env.OXAPAY_MERCHANT_API_KEY = SECRET;
  unsubscribe = paymentCallbackBus.subscribe({}, (event) => {
    if (event.provider === "oxapay") busEvents.push(event);
  });
});

// Release the bus listener so it does not leak into later in-process suites.
afterAll(() => {
  unsubscribe?.();
});

beforeEach(() => {
  markSettled.mockClear();
  markFailed.mockClear();
  busEvents = [];
});

describe("OxaPay payment_requests webhook route", () => {
  test("rejects a request without an hmac header before touching settlement", async () => {
    const body = JSON.stringify({
      orderId: "pr_nohdr",
      trackId: "trk_nohdr",
      status: "paid",
    });
    const response = await app.fetch(oxaPayRequest(body), env);

    expect(response.status).toBe(400);
    expect(markSettled).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    expect(busEvents).toHaveLength(0);
  });

  test("rejects an invalid signature — no settle, no publish", async () => {
    const body = JSON.stringify({
      orderId: "pr_badsig",
      trackId: "trk_badsig",
      status: "paid",
    });
    const response = await app.fetch(
      oxaPayRequest(body, { hmac: await sign(body, "wrong-secret") }),
      env,
    );

    expect(response.status).toBe(400);
    expect(markSettled).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    expect(busEvents).toHaveLength(0);
  });

  test("a tampered body fails verification even with a previously valid signature", async () => {
    const original = JSON.stringify({
      orderId: "pr_tamper",
      trackId: "trk_tamper",
      status: "paid",
    });
    const signature = await sign(original);
    const tampered = JSON.stringify({
      orderId: "pr_tamper",
      trackId: "trk_tamper",
      status: "paid",
      amount: "999999",
    });

    const response = await app.fetch(
      oxaPayRequest(tampered, { hmac: signature }),
      env,
    );

    expect(response.status).toBe(400);
    expect(markSettled).not.toHaveBeenCalled();
  });

  test("valid confirmed callback settles once and publishes PaymentSettled; replay publishes nothing twice", async () => {
    const body = JSON.stringify({
      orderId: "pr_settle_1",
      trackId: "trk_settle_1",
      status: "paid",
    });
    const headers = { hmac: await sign(body) };

    const first = await app.fetch(oxaPayRequest(body, headers), env);
    expect(first.status).toBe(200);
    // OxaPay's delivery contract: exactly "ok".
    await expect(first.text()).resolves.toBe("ok");
    expect(markSettled).toHaveBeenCalledTimes(1);
    expect(markSettled).toHaveBeenCalledWith(
      "pr_settle_1",
      "trk_settle_1",
      expect.objectContaining({ provider: "oxapay", trackId: "trk_settle_1" }),
    );
    expect(markFailed).not.toHaveBeenCalled();
    expect(busEvents).toHaveLength(1);
    expect(busEvents[0]).toMatchObject({
      name: "PaymentSettled",
      paymentRequestId: "pr_settle_1",
      provider: "oxapay",
      txRef: "trk_settle_1",
    });

    // Replay of the same delivery: acknowledged, persisted idempotently
    // (markSettled is a same-txRef no-op at the service layer — covered in
    // payment-requests.test.ts), and the bus publish is deduped.
    const replay = await app.fetch(oxaPayRequest(body, headers), env);
    expect(replay.status).toBe(200);
    await expect(replay.text()).resolves.toBe("ok");
    expect(markSettled).toHaveBeenCalledTimes(2);
    expect(busEvents).toHaveLength(1);
  });

  test("failed invoice marks the request failed — no credit path touched", async () => {
    const body = JSON.stringify({
      orderId: "pr_fail_1",
      trackId: "trk_fail_1",
      status: "failed",
    });
    const response = await app.fetch(
      oxaPayRequest(body, { hmac: await sign(body) }),
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
    expect(markSettled).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(markFailed).toHaveBeenCalledWith(
      "pr_fail_1",
      "OxaPay invoice failed",
    );
    expect(busEvents).toHaveLength(1);
    expect(busEvents[0]).toMatchObject({
      name: "PaymentFailed",
      paymentRequestId: "pr_fail_1",
      provider: "oxapay",
    });
  });

  test("expired invoice marks the request failed", async () => {
    const body = JSON.stringify({
      orderId: "pr_exp_1",
      trackId: "trk_exp_1",
      status: "expired",
    });
    const response = await app.fetch(
      oxaPayRequest(body, { hmac: await sign(body) }),
      env,
    );

    expect(response.status).toBe(200);
    expect(markFailed).toHaveBeenCalledWith(
      "pr_exp_1",
      "OxaPay invoice expired",
    );
    expect(markSettled).not.toHaveBeenCalled();
  });

  test("non-terminal (pending) status is acknowledged without settling", async () => {
    const body = JSON.stringify({
      orderId: "pr_pending_1",
      trackId: "trk_pending_1",
      status: "waiting",
    });
    const response = await app.fetch(
      oxaPayRequest(body, { hmac: await sign(body) }),
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
    expect(markSettled).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    expect(busEvents).toHaveLength(0);
  });

  test("callback without an orderId is ignored (not one of our payment_requests)", async () => {
    const body = JSON.stringify({ trackId: "trk_legacy", status: "paid" });
    const response = await app.fetch(
      oxaPayRequest(body, { hmac: await sign(body) }),
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
    expect(markSettled).not.toHaveBeenCalled();
  });

  test("persistence failure returns 500 so OxaPay retries, and does NOT poison the replay dedupe", async () => {
    const body = JSON.stringify({
      orderId: "pr_retry_1",
      trackId: "trk_retry_1",
      status: "paid",
    });
    const headers = { hmac: await sign(body) };

    markSettled.mockRejectedValueOnce(new Error("transient db failure"));
    const failed = await app.fetch(oxaPayRequest(body, headers), env);
    expect(failed.status).toBe(500);
    await expect(failed.text()).resolves.toBe("error");
    expect(busEvents).toHaveLength(0);

    // OxaPay retries the same delivery → it must settle this time.
    const retry = await app.fetch(oxaPayRequest(body, headers), env);
    expect(retry.status).toBe(200);
    expect(markSettled).toHaveBeenCalledTimes(2);
    expect(busEvents).toHaveLength(1);
    expect(busEvents[0]?.name).toBe("PaymentSettled");
  });

  test("rejects a non-allowlisted source IP when OXAPAY_WEBHOOK_IPS is set", async () => {
    const body = JSON.stringify({
      orderId: "pr_ip_1",
      trackId: "trk_ip_1",
      status: "paid",
    });
    const response = await app.fetch(
      oxaPayRequest(body, {
        hmac: await sign(body),
        "x-forwarded-for": "203.0.113.99",
      }),
      { OXAPAY_WEBHOOK_IPS: "198.51.100.1, 198.51.100.2" },
    );

    expect(response.status).toBe(403);
    expect(markSettled).not.toHaveBeenCalled();

    const allowed = await app.fetch(
      oxaPayRequest(body, {
        hmac: await sign(body),
        "x-forwarded-for": "198.51.100.2",
      }),
      { OXAPAY_WEBHOOK_IPS: "198.51.100.1, 198.51.100.2" },
    );
    expect(allowed.status).toBe(200);
    expect(markSettled).toHaveBeenCalledTimes(1);
  });
});
