/**
 * x402 settle route — facilitator failures must not leak internal error text
 * (upstream RPC endpoints, account addresses, provider detail) to
 * unauthenticated callers: the boundary collapses every throw to the constant
 * `errorReason: "internal_error"` and keeps the detail in server logs. The
 * facilitator edge is mocked; the real route drives the response shape.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const SENSITIVE_MESSAGE =
  "RPC https://mainnet.infura.io/v3/abc123 failed for account 0xDEADBEEF: nonce too low";

let settleBehavior: () => Promise<unknown> = async () => ({
  success: true,
  transaction: "0xtx",
  network: "base",
});
const settle = mock(() => settleBehavior());
const errorLog = mock((..._args: unknown[]) => undefined);

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STRICT: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  moneyRateLimit: () => async (_c: unknown, next: () => Promise<void>) =>
    next(),
}));

mock.module("@/lib/services/x402-facilitator", () => ({
  x402FacilitatorService: { settle },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: errorLog,
    debug: mock(() => undefined),
  },
}));

const { default: settleRoute } = await import("./route");

function post(body: Record<string, unknown>) {
  const app = new Hono();
  app.route("/api/v1/x402/settle", settleRoute);
  return app.fetch(
    new Request("https://api.example.test/api/v1/x402/settle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    {},
  );
}

const VALID_BODY = {
  paymentPayload: { scheme: "exact" },
  paymentRequirements: { network: "base" },
};

describe("x402 settle route — internal error collapse", () => {
  beforeEach(() => {
    settle.mockClear();
    errorLog.mockClear();
    settleBehavior = async () => ({
      success: true,
      transaction: "0xtx",
      network: "base",
    });
  });

  test("a facilitator throw returns the constant internal_error reason", async () => {
    settleBehavior = async () => {
      throw new Error(SENSITIVE_MESSAGE);
    };

    const res = await post(VALID_BODY);
    expect(res.status).toBe(500);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      success: false,
      transaction: "",
      network: "",
      errorReason: "internal_error",
    });
    expect(JSON.stringify(body)).not.toContain("infura");
    expect(JSON.stringify(body)).not.toContain("0xDEADBEEF");
  });

  test("the internal detail is still logged server-side", async () => {
    settleBehavior = async () => {
      throw new Error(SENSITIVE_MESSAGE);
    };

    await post(VALID_BODY);
    expect(errorLog).toHaveBeenCalledTimes(1);
    const logged = String(errorLog.mock.calls[0]?.[0]);
    expect(logged).toContain(SENSITIVE_MESSAGE);
  });

  test("a non-Error throw collapses the same way", async () => {
    settleBehavior = async () => {
      throw "string failure with https://rpc.internal/detail";
    };

    const res = await post(VALID_BODY);
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.errorReason).toBe("internal_error");
    expect(JSON.stringify(body)).not.toContain("rpc.internal");
  });

  test("a successful settle passes the facilitator result through", async () => {
    const res = await post(VALID_BODY);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      transaction: "0xtx",
    });
  });

  test("a facilitator failure result keeps its own 400 payload", async () => {
    settleBehavior = async () => ({
      success: false,
      transaction: "",
      network: "base",
      errorReason: "insufficient_funds",
    });

    const res = await post(VALID_BODY);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      errorReason: "insufficient_funds",
    });
  });
});
