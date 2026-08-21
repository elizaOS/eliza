/**
 * x402 verify route — facilitator failures must not leak internal error text
 * (upstream RPC endpoints, account addresses, provider detail) to
 * unauthenticated callers: the boundary collapses every throw to the constant
 * `invalidReason: "internal_error"` and keeps the detail in server logs. The
 * facilitator edge is mocked; the real route drives the response shape.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const SENSITIVE_MESSAGE =
  "RPC https://mainnet.infura.io/v3/abc123 failed for account 0xDEADBEEF: nonce too low";

let verifyBehavior: () => Promise<unknown> = async () => ({ isValid: true });
const verify = mock(() => verifyBehavior());
const errorLog = mock((..._args: unknown[]) => undefined);

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STRICT: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  moneyRateLimit: () => async (_c: unknown, next: () => Promise<void>) =>
    next(),
}));

mock.module("@/lib/services/x402-facilitator", () => ({
  x402FacilitatorService: { verify },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: errorLog,
    debug: mock(() => undefined),
  },
}));

const { default: verifyRoute } = await import("./route");

function post(body: Record<string, unknown>) {
  const app = new Hono();
  app.route("/api/v1/x402/verify", verifyRoute);
  return app.fetch(
    new Request("https://api.example.test/api/v1/x402/verify", {
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

describe("x402 verify route — internal error collapse", () => {
  beforeEach(() => {
    verify.mockClear();
    errorLog.mockClear();
    verifyBehavior = async () => ({ isValid: true });
  });

  test("a facilitator throw returns the constant internal_error reason", async () => {
    verifyBehavior = async () => {
      throw new Error(SENSITIVE_MESSAGE);
    };

    const res = await post(VALID_BODY);
    expect(res.status).toBe(500);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ isValid: false, invalidReason: "internal_error" });
    expect(JSON.stringify(body)).not.toContain("infura");
    expect(JSON.stringify(body)).not.toContain("0xDEADBEEF");
  });

  test("the internal detail is still logged server-side", async () => {
    verifyBehavior = async () => {
      throw new Error(SENSITIVE_MESSAGE);
    };

    await post(VALID_BODY);
    expect(errorLog).toHaveBeenCalledTimes(1);
    const logged = String(errorLog.mock.calls[0]?.[0]);
    expect(logged).toContain(SENSITIVE_MESSAGE);
  });

  test("a facilitator invalid result keeps its own 400 payload", async () => {
    verifyBehavior = async () => ({
      isValid: false,
      invalidReason: "insufficient_funds",
    });

    const res = await post(VALID_BODY);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      invalidReason: "insufficient_funds",
    });
  });
});
