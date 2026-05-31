import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelUsageEventPayload } from "../../src/utils/events";
import {
  buildInferenceSpentPayload,
  createWaifuMeteringHandler,
  estimateUsd,
  postInferenceSpent,
  resolveWaifuMeteringConfig,
  signWaifuWebhook,
  type WaifuMeteringConfig,
} from "../../src/utils/waifu-metering";

const CONFIG: WaifuMeteringConfig = {
  webhookUrl: "https://api.waifu.fun/v2/webhooks/eliza-cloud/inference",
  secret: "test-secret",
  agentId: "agent-123",
  usdPer1kInput: 0.003,
  usdPer1kOutput: 0.015,
};

function makeRuntime(env: Record<string, string>): any {
  return {
    getSetting: (key: string) => env[key],
  };
}

function makePayload(
  tokens: { prompt: number; completion: number; total?: number },
  extra: Partial<ModelUsageEventPayload> = {}
): ModelUsageEventPayload {
  return {
    runtime: makeRuntime({}) as ModelUsageEventPayload["runtime"],
    source: "elizacloud",
    type: "TEXT_LARGE" as ModelUsageEventPayload["type"],
    tokens: {
      prompt: tokens.prompt,
      completion: tokens.completion,
      total: tokens.total ?? tokens.prompt + tokens.completion,
    },
    ...extra,
  };
}

describe("resolveWaifuMeteringConfig", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns null when metering env is absent", () => {
    expect(resolveWaifuMeteringConfig(makeRuntime({}))).toBeNull();
  });

  it("returns null when only some knobs are present", () => {
    const runtime = makeRuntime({
      WAIFU_INFERENCE_WEBHOOK_URL: CONFIG.webhookUrl,
      WAIFU_WEBHOOK_SECRET: CONFIG.secret,
      // missing WAIFU_AGENT_ID
    });
    expect(resolveWaifuMeteringConfig(runtime)).toBeNull();
  });

  it("resolves config from env with defaults", () => {
    const runtime = makeRuntime({
      WAIFU_INFERENCE_WEBHOOK_URL: CONFIG.webhookUrl,
      WAIFU_WEBHOOK_SECRET: CONFIG.secret,
      WAIFU_AGENT_ID: CONFIG.agentId,
    });
    const resolved = resolveWaifuMeteringConfig(runtime);
    expect(resolved).toMatchObject({
      webhookUrl: CONFIG.webhookUrl,
      secret: CONFIG.secret,
      agentId: CONFIG.agentId,
    });
    expect(resolved?.usdPer1kInput).toBeGreaterThan(0);
    expect(resolved?.usdPer1kOutput).toBeGreaterThan(0);
  });

  it("falls back to WAIFU_WEBHOOK_URL when inference url not set", () => {
    const runtime = makeRuntime({
      WAIFU_WEBHOOK_URL: "https://api.waifu.fun/v2/webhooks/eliza-cloud/credits",
      WAIFU_WEBHOOK_SECRET: CONFIG.secret,
      WAIFU_AGENT_ID: CONFIG.agentId,
    });
    expect(resolveWaifuMeteringConfig(runtime)?.webhookUrl).toContain("/credits");
  });
});

describe("signWaifuWebhook", () => {
  it("matches waifu's sha256=HMAC(timestamp.body) format", () => {
    const body = '{"hello":"world"}';
    const ts = "2026-05-31T05:00:00.000Z";
    const expected = `sha256=${crypto.createHmac("sha256", CONFIG.secret).update(`${ts}.${body}`).digest("hex")}`;
    expect(signWaifuWebhook(body, ts, CONFIG.secret)).toBe(expected);
  });
});

describe("estimateUsd", () => {
  it("prices input and output tokens separately", () => {
    const usd = estimateUsd(CONFIG, 1000, 1000);
    expect(usd).toBeCloseTo(0.003 + 0.015, 6);
  });

  it("returns 0 for no tokens", () => {
    expect(estimateUsd(CONFIG, 0, 0)).toBe(0);
  });
});

describe("buildInferenceSpentPayload", () => {
  it("prefers authoritative gateway cost when present", () => {
    const payload = makePayload({ prompt: 500, completion: 200 }, { costUsd: 0.0123 });
    const spent = buildInferenceSpentPayload(CONFIG, payload);
    expect(spent?.usd).toBe(0.0123);
    expect(spent?.costSource).toBe("gateway");
    expect(spent?.agentId).toBe(CONFIG.agentId);
    expect(spent?.promptTokens).toBe(500);
    expect(spent?.completionTokens).toBe(200);
    expect(spent?.totalTokens).toBe(700);
  });

  it("falls back to a token estimate when no gateway cost", () => {
    const payload = makePayload({ prompt: 1000, completion: 1000 });
    const spent = buildInferenceSpentPayload(CONFIG, payload);
    expect(spent?.costSource).toBe("estimate");
    expect(spent?.usd).toBeCloseTo(0.018, 6);
  });

  it("returns null for a zero-token call", () => {
    const payload = makePayload({ prompt: 0, completion: 0, total: 0 });
    expect(buildInferenceSpentPayload(CONFIG, payload)).toBeNull();
  });

  it("emits a unique idempotency key per call", () => {
    const payload = makePayload({ prompt: 10, completion: 10 });
    const a = buildInferenceSpentPayload(CONFIG, payload);
    const b = buildInferenceSpentPayload(CONFIG, payload);
    expect(a?.idempotencyKey).not.toBe(b?.idempotencyKey);
    expect(a?.idempotencyKey.startsWith(`inference:${CONFIG.agentId}:`)).toBe(true);
  });
});

describe("postInferenceSpent", () => {
  it("posts a signed payload and reports ok", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 202 } as Response;
    }) as unknown as typeof fetch;

    const payload = buildInferenceSpentPayload(
      CONFIG,
      makePayload({ prompt: 100, completion: 50 }, { costUsd: 0.01 })
    );
    const result = await postInferenceSpent(CONFIG, payload!, fakeFetch);

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const sentBody = String(calls[0].init.body);
    const headers = calls[0].init.headers as Record<string, string>;
    const expectedSig = signWaifuWebhook(sentBody, payload!.timestamp, CONFIG.secret);
    expect(headers["X-Waifu-Webhook-Signature"]).toBe(expectedSig);
    expect(headers["X-Waifu-Signature"]).toBe(expectedSig);
  });

  it("never throws on fetch failure", async () => {
    const fakeFetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const payload = buildInferenceSpentPayload(CONFIG, makePayload({ prompt: 1, completion: 1 }));
    await expect(postInferenceSpent(CONFIG, payload!, fakeFetch)).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe("createWaifuMeteringHandler", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is a no-op when metering env is absent", async () => {
    const fakeFetch = vi.fn() as unknown as typeof fetch;
    const handler = createWaifuMeteringHandler(fakeFetch);
    await handler(makePayload({ prompt: 100, completion: 50 }));
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("posts when metering env is present", async () => {
    const fakeFetch = vi.fn(
      async () => ({ ok: true, status: 202 }) as Response
    ) as unknown as typeof fetch;
    const handler = createWaifuMeteringHandler(fakeFetch);
    const runtime = makeRuntime({
      WAIFU_INFERENCE_WEBHOOK_URL: CONFIG.webhookUrl,
      WAIFU_WEBHOOK_SECRET: CONFIG.secret,
      WAIFU_AGENT_ID: CONFIG.agentId,
    });
    await handler(makePayload({ prompt: 100, completion: 50 }, { runtime }));
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });
});
