/**
 * Unit tests for the waifu webhook emitter — the previously-missing emit side
 * of the Eliza Cloud -> waifu money/auth seam.
 *
 * These lock the contract that waifu's signed receiver verifies:
 *   - HMAC-SHA256 over `${timestamp}.${rawBody}` in X-Waifu-Webhook-Signature
 *   - a stable idempotencyKey in the body (replay protection)
 *   - correct receiver path per event kind
 *   - clean no-op when the target is not configured
 *
 * The signature recomputation here is byte-for-byte identical to waifu's
 * `signWebhookPayload` (apps/api/src/routes/v2/webhooks.ts), so a green test
 * means a real waifu receiver would accept the delivery.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import {
  classifyCreditBalance,
  emitWaifuCreditWebhook,
  emitWaifuInferenceWebhook,
  emitWaifuWebhook,
  isWaifuWebhookTargetUrl,
  resolveWaifuWebhookTarget,
  signWaifuWebhook,
} from "./waifu-webhook";

const TARGET = { baseUrl: "https://api.waifu.fun", secret: "x".repeat(48) };

function waifuVerify(rawBody: string, timestamp: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

type Captured = { url: string; headers: Record<string, string>; body: string };

function captureFetch(status = 202): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const headerObj: Record<string, string> = {};
    const h = init?.headers as Record<string, string> | undefined;
    if (h) for (const [k, v] of Object.entries(h)) headerObj[k] = v;
    calls.push({ url: url.toString(), headers: headerObj, body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ status: "accepted" }), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("resolveWaifuWebhookTarget", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  test("returns null when not configured", () => {
    process.env.WAIFU_WEBHOOK_URL = "";
    process.env.WAIFU_WEBHOOK_SECRET = "";
    process.env.WEBHOOK_RECEIVER_SECRET = "";
    process.env.WAIFU_API_BASE_URL = "";
    process.env.WAIFU_CORE_URL = "";
    expect(resolveWaifuWebhookTarget()).toBeNull();
  });

  test("resolves from WAIFU_WEBHOOK_URL + WAIFU_WEBHOOK_SECRET and strips trailing slash", () => {
    process.env.WAIFU_WEBHOOK_URL = "https://api.waifu.fun/";
    process.env.WAIFU_WEBHOOK_SECRET = "s".repeat(40);
    const target = resolveWaifuWebhookTarget();
    expect(target).toEqual({ baseUrl: "https://api.waifu.fun", secret: "s".repeat(40) });
  });
});

describe("emitWaifuWebhook signing + delivery", () => {
  test("posts to the credits receiver with a waifu-verifiable signature", async () => {
    const { fetchImpl, calls } = captureFetch();
    const result = await emitWaifuWebhook({
      kind: "credits",
      idempotencyKey: "evt-1",
      target: TARGET,
      fetchImpl,
      now: () => new Date("2026-05-31T05:00:00.000Z"),
      payload: { event: "credits.low", balance: 4 },
    });

    expect(result.delivered).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.waifu.fun/v2/webhooks/eliza-cloud/credits");

    const body = JSON.parse(calls[0].body);
    expect(body.idempotencyKey).toBe("evt-1");
    expect(body.timestamp).toBe("2026-05-31T05:00:00.000Z");

    const expected = waifuVerify(calls[0].body, body.timestamp, TARGET.secret);
    expect(calls[0].headers["X-Waifu-Webhook-Signature"]).toBe(expected);
  });

  test("routes inference events to the inference receiver", async () => {
    const { fetchImpl, calls } = captureFetch();
    await emitWaifuWebhook({
      kind: "inference",
      idempotencyKey: "inf-1",
      target: TARGET,
      fetchImpl,
      payload: { event: "inference.spent", usd: 0.01 },
    });
    expect(calls[0].url).toBe("https://api.waifu.fun/v2/webhooks/eliza-cloud/inference");
  });

  test("no-ops cleanly when target is not configured", async () => {
    const { fetchImpl, calls } = captureFetch();
    const result = await emitWaifuWebhook({
      kind: "credits",
      idempotencyKey: "evt-2",
      fetchImpl,
      payload: { event: "credits.low" },
    });
    expect(result.skipped).toBe("not_configured");
    expect(result.delivered).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("never throws on delivery error; returns delivered=false", async () => {
    const fetchImpl = (async () => {
      throw new Error("connection reset");
    }) as unknown as typeof fetch;
    const result = await emitWaifuWebhook({
      kind: "credits",
      idempotencyKey: "evt-3",
      target: TARGET,
      fetchImpl,
      payload: { event: "credits.low" },
    });
    expect(result.delivered).toBe(false);
    expect(result.error).toContain("connection reset");
  });

  test("signWaifuWebhook matches waifu's scheme exactly", () => {
    const ts = "2026-05-31T05:00:00.000Z";
    const raw = JSON.stringify({ event: "credits.low", timestamp: ts });
    expect(signWaifuWebhook(raw, ts, TARGET.secret)).toBe(waifuVerify(raw, ts, TARGET.secret));
  });
});

describe("isWaifuWebhookTargetUrl (signed-envelope gating)", () => {
  test("true when the callback origin matches the waifu target", () => {
    expect(
      isWaifuWebhookTargetUrl("https://api.waifu.fun/v2/webhooks/eliza-cloud/credits", TARGET),
    ).toBe(true);
  });
  test("false for a non-waifu callback url so its payload stays unsigned", () => {
    expect(isWaifuWebhookTargetUrl("https://example.com/job-callback", TARGET)).toBe(false);
  });
  test("false for a malformed url", () => {
    expect(isWaifuWebhookTargetUrl("not a url", TARGET)).toBe(false);
  });
});

describe("classifyCreditBalance (money-path threshold mapping)", () => {
  test("depleted at or below zero", () => {
    expect(classifyCreditBalance(0, 1000)).toBe("depleted");
    expect(classifyCreditBalance(-3, 1000)).toBe("depleted");
  });
  test("low between zero and the threshold", () => {
    expect(classifyCreditBalance(0.5, 1000)).toBe("low");
    expect(classifyCreditBalance(1000, 1000)).toBe("low");
  });
  test("no signal above the threshold", () => {
    expect(classifyCreditBalance(1000.01, 1000)).toBeNull();
    expect(classifyCreditBalance(5000, 1000)).toBeNull();
  });
});

describe("emitWaifuCreditWebhook", () => {
  test("maps depleted balance to credits.depleted and carries ids", async () => {
    const { fetchImpl, calls } = captureFetch();
    await emitWaifuCreditWebhook({
      status: "depleted",
      organizationId: "org-1",
      newBalance: 0,
      cloudAgentId: "cloud-agent-9",
      target: TARGET,
      fetchImpl,
    });
    const body = JSON.parse(calls[0].body);
    expect(body.event).toBe("credits.depleted");
    expect(body.elizaCloudAgentId).toBe("cloud-agent-9");
    expect(body.creditsRemaining).toBe(0);
  });

  test("maps low balance to credits.low", async () => {
    const { fetchImpl, calls } = captureFetch();
    await emitWaifuCreditWebhook({
      status: "low",
      organizationId: "org-1",
      newBalance: 3,
      threshold: 5,
      target: TARGET,
      fetchImpl,
    });
    const body = JSON.parse(calls[0].body);
    expect(body.event).toBe("credits.low");
    expect(body.balance).toBe(3);
    expect(body.threshold).toBe(5);
  });
});

describe("emitWaifuInferenceWebhook", () => {
  test("emits inference.spent with usd + tokens", async () => {
    const { fetchImpl, calls } = captureFetch();
    await emitWaifuInferenceWebhook({
      organizationId: "org-1",
      usd: 0.0123,
      tokens: 742,
      model: "gpt-4o",
      transactionId: "tx-77",
      target: TARGET,
      fetchImpl,
    });
    const body = JSON.parse(calls[0].body);
    expect(body.event).toBe("inference.spent");
    expect(body.usd).toBe(0.0123);
    expect(body.tokens).toBe(742);
    expect(body.idempotencyKey).toBe("tx-77");
  });
});
