/**
 * Exercises the legacy OxaPay webhook's durable marker lifecycle without
 * contacting OxaPay or using payment credentials.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as loggerActual from "@/lib/utils/logger";

const SECRET = "test-legacy-oxapay-webhook-secret";

const tryCreate = mock(async (_marker: { event_id: string }) => ({
  created: true,
}));
const deleteByEventId = mock(async () => undefined);
const handleWebhook = mock(async () => ({
  success: true,
  message: "Payment confirmed",
}));
const loggerError = mock();
const loggerInfo = mock();
const loggerWarn = mock();

mock.module("@/db/repositories/webhook-events", () => ({
  webhookEventsRepository: {
    tryCreate,
    deleteByEventId,
  },
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: {
    STANDARD: "standard",
  },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
  moneyRateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

mock.module("@/lib/services/crypto-payments", () => ({
  cryptoPaymentsService: {
    handleWebhook,
  },
}));

mock.module("@/lib/services/oxapay", () => ({
  isOxaPayConfigured: () => true,
}));

mock.module("@/lib/utils/logger", () => ({
  ...loggerActual,
  logger: {
    ...loggerActual.logger,
    error: loggerError,
    info: loggerInfo,
    warn: loggerWarn,
  },
}));

const { default: app } = await import("../crypto/webhook/route");

const env = {
  OXAPAY_MERCHANT_API_KEY: SECRET,
};

async function sign(body: string): Promise<string> {
  const encoded = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoded.encode(SECRET),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoded.encode(body));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sendWebhook(): Promise<Response> {
  const body = JSON.stringify({
    trackId: "track_retry_1",
    status: "Paid",
    amount: 25,
    txID: "tx_retry_1",
  });
  return app.fetch(
    new Request("https://api.example.test/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        hmac: await sign(body),
      },
      body,
    }),
    env,
  );
}

function claimedEventId(): string {
  const marker = tryCreate.mock.calls[0]?.[0];
  if (typeof marker?.event_id !== "string") {
    throw new Error("Expected the route to claim a webhook event");
  }
  return marker.event_id;
}

beforeEach(() => {
  tryCreate.mockReset();
  tryCreate.mockResolvedValue({ created: true });
  deleteByEventId.mockReset();
  deleteByEventId.mockResolvedValue(undefined);
  handleWebhook.mockReset();
  handleWebhook.mockResolvedValue({
    success: true,
    message: "Payment confirmed",
  });
  loggerError.mockClear();
  loggerInfo.mockClear();
  loggerWarn.mockClear();
});

describe("legacy OxaPay webhook marker recovery", () => {
  test("keeps the marker and acknowledges successful settlement", async () => {
    const response = await sendWebhook();

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
    expect(handleWebhook).toHaveBeenCalledTimes(1);
    expect(deleteByEventId).not.toHaveBeenCalled();
  });

  test("verifies a duplicate through the idempotent settlement service", async () => {
    tryCreate.mockResolvedValueOnce({ created: false });
    handleWebhook.mockResolvedValueOnce({
      success: true,
      message: "Payment already processed",
    });

    const response = await sendWebhook();

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
    expect(handleWebhook).toHaveBeenCalledTimes(1);
    expect(deleteByEventId).not.toHaveBeenCalled();
  });

  test("does not acknowledge or delete another request's marker when duplicate settlement fails", async () => {
    tryCreate.mockResolvedValueOnce({ created: false });
    handleWebhook.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await sendWebhook();

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe("error");
    expect(handleWebhook).toHaveBeenCalledTimes(1);
    expect(deleteByEventId).not.toHaveBeenCalled();
  });

  test("rolls back the marker and requests retry when settlement throws", async () => {
    handleWebhook.mockRejectedValueOnce(
      new Error(
        "Failed query: update crypto_payments; params: track_retry_1, test-processing-secret-canary",
      ),
    );

    const response = await sendWebhook();

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe("error");
    expect(deleteByEventId).toHaveBeenCalledTimes(1);
    expect(deleteByEventId).toHaveBeenCalledWith(claimedEventId(), "oxapay");
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(
      "track_retry_1",
    );
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(
      "test-processing-secret-canary",
    );
  });

  test("lets the same delivery reach settlement after rollback", async () => {
    let claimed = false;
    tryCreate.mockImplementation(async () => {
      if (claimed) return { created: false };
      claimed = true;
      return { created: true };
    });
    deleteByEventId.mockImplementation(async () => {
      claimed = false;
    });
    handleWebhook
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce({
        success: true,
        message: "Payment confirmed",
      });

    const first = await sendWebhook();
    expect(first.status).toBe(500);

    const retry = await sendWebhook();
    expect(retry.status).toBe(200);
    await expect(retry.text()).resolves.toBe("ok");
    expect(handleWebhook).toHaveBeenCalledTimes(2);
  });

  test("rolls back the marker and requests retry for a negative result", async () => {
    handleWebhook.mockResolvedValueOnce({
      success: false,
      message: "Payment not found",
    });

    const response = await sendWebhook();

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe("error");
    expect(deleteByEventId).toHaveBeenCalledWith(claimedEventId(), "oxapay");
  });

  test("never acknowledges failure when marker rollback also fails", async () => {
    handleWebhook.mockRejectedValueOnce(new Error("database unavailable"));
    deleteByEventId.mockRejectedValueOnce(
      new Error(
        "Failed query: delete from webhook_events where event_id = $1; params: oxapay_track_retry_1_paid_payload, test-db-secret-canary",
      ),
    );

    const response = await sendWebhook();

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe("error");
    expect(deleteByEventId).toHaveBeenCalledWith(claimedEventId(), "oxapay");
    expect(JSON.stringify(loggerWarn.mock.calls)).not.toContain(
      "track_retry_1",
    );
    expect(JSON.stringify(loggerWarn.mock.calls)).not.toContain("tx_retry_1");
    expect(JSON.stringify(loggerWarn.mock.calls)).not.toContain(
      "test-db-secret-canary",
    );
    expect(loggerWarn).toHaveBeenCalledWith(
      "[Crypto Webhook] Processing failed and dedup-marker rollback failed",
      expect.objectContaining({ errorType: "marker_delete_failed" }),
    );
  });
});
