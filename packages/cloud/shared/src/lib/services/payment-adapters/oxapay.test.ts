// Exercises oxapay behavior with deterministic cloud-shared lib fixtures.
import { beforeAll, describe, expect, test } from "bun:test";
import { IgnoredWebhookEvent } from "../payment-webhook-errors";
import { createOxaPayPaymentAdapter } from "./oxapay";

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
});
