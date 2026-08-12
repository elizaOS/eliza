// Exercises oxapay behavior with deterministic cloud-shared lib fixtures.
import { afterEach, beforeAll, describe, expect, mock, setSystemTime, test } from "bun:test";
import type { PaymentRequestRow } from "../payment-requests";
import { IgnoredWebhookEvent } from "../payment-webhook-errors";
import { createOxaPayPaymentAdapter, oxaPayLifetimeSeconds } from "./oxapay";

const SECRET = "test-oxapay-merchant-key";

async function sign(body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(SECRET),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

beforeAll(() => {
  process.env.OXAPAY_MERCHANT_API_KEY = SECRET;
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  setSystemTime();
});

const adapter = createOxaPayPaymentAdapter();

describe("OxaPay payment adapter", () => {
  test("provider is oxapay", () => {
    expect(adapter.provider).toBe("oxapay");
  });

  test("parseWebhook: valid signature + confirmed → settled, maps orderId", async () => {
    const body = JSON.stringify({
      orderId: "pr_abc123",
      trackId: "trk_999",
      status: "paid",
    });
    const result = await adapter.parseWebhook!({ rawBody: body, signature: await sign(body) });
    expect(result.paymentRequestId).toBe("pr_abc123");
    expect(result.status).toBe("settled");
    expect(result.txRef).toBe("trk_999");
    expect(result.proof.provider).toBe("oxapay");
  });

  test("parseWebhook: valid signature + failed → failed", async () => {
    const body = JSON.stringify({ orderId: "pr_x", trackId: "t", status: "failed" });
    const result = await adapter.parseWebhook!({ rawBody: body, signature: await sign(body) });
    expect(result.status).toBe("failed");
    expect(result.paymentRequestId).toBe("pr_x");
  });

  test("parseWebhook: invalid signature is rejected", async () => {
    const body = JSON.stringify({ orderId: "pr_x", status: "paid" });
    await expect(adapter.parseWebhook!({ rawBody: body, signature: "deadbeef" })).rejects.toThrow(
      /signature/i,
    );
  });

  test("parseWebhook: missing signature is rejected", async () => {
    const body = JSON.stringify({ orderId: "pr_x", status: "paid" });
    await expect(adapter.parseWebhook!({ rawBody: body, signature: null })).rejects.toThrow(
      /signature/i,
    );
  });

  test("parseWebhook: pending status is ignored (not terminal)", async () => {
    const body = JSON.stringify({ orderId: "pr_x", status: "waiting" });
    await expect(
      adapter.parseWebhook!({ rawBody: body, signature: await sign(body) }),
    ).rejects.toBeInstanceOf(IgnoredWebhookEvent);
  });

  test("parseWebhook: no orderId is ignored (not one of our requests)", async () => {
    const body = JSON.stringify({ trackId: "t", status: "paid" });
    await expect(
      adapter.parseWebhook!({ rawBody: body, signature: await sign(body) }),
    ).rejects.toBeInstanceOf(IgnoredWebhookEvent);
  });

  test("createIntent rejects a non-oxapay request", async () => {
    await expect(
      adapter.createIntent({
        request: { id: "x", provider: "stripe", amountCents: 100n } as never,
      }),
    ).rejects.toThrow(/non-oxapay/i);
  });

  test("createIntent rounds the provider lifetime down to the request deadline", async () => {
    const now = new Date("2026-08-13T00:00:00.000Z");
    const deadline = new Date("2026-08-13T00:16:59.999Z");
    setSystemTime(now);
    process.env.NEXT_PUBLIC_APP_URL = "https://api.example.test";
    const fetchMock = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { lifeTime: number };
      expect(body.lifeTime).toBe(16);
      return new Response(
        JSON.stringify({
          result: 100,
          trackId: "trk-deadline",
          payLink: "https://pay.oxapay.example.test/invoice",
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const request = {
      id: "00000000-0000-0000-0000-000000000001",
      provider: "oxapay",
      amountCents: 500,
      currency: "USD",
      reason: "Synthetic payment",
      expiresAt: deadline,
      metadata: {},
    } as PaymentRequestRow;
    const result = await adapter.createIntent({ request });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.providerIntent.oxapay_expires_at).toBe(
      new Date(now.getTime() + 16 * 60_000).toISOString(),
    );
    expect(new Date(String(result.providerIntent.oxapay_expires_at)).getTime()).toBeLessThanOrEqual(
      deadline.getTime(),
    );
  });

  test("rejects provider lifetimes outside OxaPay's supported window", () => {
    const now = Date.parse("2026-08-13T00:00:00.000Z");
    expect(() => oxaPayLifetimeSeconds(new Date(now + 15 * 60_000 - 1), now)).toThrow(
      /at least 15 whole minutes/,
    );
    expect(() => oxaPayLifetimeSeconds(new Date(now + 2881 * 60_000), now)).toThrow(
      /more than 2880 minutes/,
    );
  });
});
