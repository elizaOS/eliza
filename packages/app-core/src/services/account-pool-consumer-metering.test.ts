/**
 * Unit and integration tests for account-pool consumer-key authentication,
 * quota reservation, and usage metering. Covers key creation/rotation/lookup,
 * header sanitization, reservation admission under daily quotas, JSONL usage
 * persistence, and Anthropic SSE streaming usage aggregation.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetAccountPoolConsumerMeteringForTests,
  admitAccountPoolConsumerRequest,
  anthropicAuthError,
  anthropicQuotaError,
  authenticateAccountPoolConsumerRequest,
  createAccountPoolConsumerKey,
  createAnthropicSseUsageMeter,
  estimateAnthropicRequestReservation,
  extractAnthropicUsageFromJson,
  findAccountPoolConsumerByKey,
  getAccountPoolConsumerUsageSummary,
  listAccountPoolConsumerKeys,
  parseAnthropicSseEventUsage,
  queryAccountPoolConsumerUsage,
  recordAccountPoolConsumerUsage,
  rotateAccountPoolConsumerKey,
  stripAccountPoolConsumerCredentialHeaders,
  updateAccountPoolConsumerKey,
} from "./account-pool-consumer-metering.js";

let stateDir: string;
let prevStateDir: string | undefined;
let prevPublicAuth: string | undefined;
let prevBrokerSecret: string | undefined;

beforeEach(() => {
  prevStateDir = process.env.ELIZA_STATE_DIR;
  prevPublicAuth = process.env.ELIZA_ACCOUNT_POOL_CONSUMER_AUTH_ENABLED;
  prevBrokerSecret = process.env.ELIZA_ACCOUNT_POOL_BROKER_SECRET;
  stateDir = mkdtempSync(path.join(tmpdir(), "consumer-metering-"));
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_ACCOUNT_POOL_CONSUMER_AUTH_ENABLED = "1";
  process.env.ELIZA_ACCOUNT_POOL_BROKER_SECRET =
    "admin-broker-secret-admin-broker-secret";
  __resetAccountPoolConsumerMeteringForTests();
});

afterEach(() => {
  __resetAccountPoolConsumerMeteringForTests();
  if (prevStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = prevStateDir;
  if (prevPublicAuth === undefined)
    delete process.env.ELIZA_ACCOUNT_POOL_CONSUMER_AUTH_ENABLED;
  else process.env.ELIZA_ACCOUNT_POOL_CONSUMER_AUTH_ENABLED = prevPublicAuth;
  if (prevBrokerSecret === undefined)
    delete process.env.ELIZA_ACCOUNT_POOL_BROKER_SECRET;
  else process.env.ELIZA_ACCOUNT_POOL_BROKER_SECRET = prevBrokerSecret;
  rmSync(stateDir, { recursive: true, force: true });
});

async function pipeMeteredSse(chunks: string[]): Promise<{
  output: string;
  observed: unknown[];
}> {
  const observed: unknown[] = [];
  const stream = createAnthropicSseUsageMeter((usage) => {
    observed.push(usage);
  });
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const collected: string[] = [];

  const readPromise = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      collected.push(decoder.decode(value, { stream: true }));
    }
  })();

  for (const chunk of chunks) {
    await writer.write(encoder.encode(chunk));
  }
  await writer.close();
  await readPromise;
  return { output: collected.join(""), observed };
}

describe("consumer key lifecycle and management", () => {
  it("creates a key with defaults and lists public representation", () => {
    const created = createAccountPoolConsumerKey();
    expect(created).not.toBeNull();
    if (!created) throw new Error("expected created key");
    expect(created.key.startsWith("eliza_cp_")).toBe(true);
    expect(created.consumer.label).toBe("consumer");
    expect(created.consumer.enabled).toBe(true);
    expect(created.consumer.dailyTokenQuota).toBeNull();
    expect(created.consumer.keyPrefix).toBe(created.key.slice(0, 18));
    expect(created.consumer.id.startsWith("ck_")).toBe(true);

    const list = listAccountPoolConsumerKeys();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(created.consumer.id);
    expect(
      (list[0] as unknown as { keyDigest?: string }).keyDigest,
    ).toBeUndefined();
  });

  it("creates a key with custom label, disabled state, and quota", () => {
    const created = createAccountPoolConsumerKey({
      label: " analytics-agent ",
      enabled: false,
      dailyTokenQuota: 50_000,
    });
    expect(created).not.toBeNull();
    if (!created) throw new Error("expected created key");
    expect(created.consumer.label).toBe("analytics-agent");
    expect(created.consumer.enabled).toBe(false);
    expect(created.consumer.dailyTokenQuota).toBe(50_000);
  });

  it("rejects invalid key creation parameters", () => {
    expect(createAccountPoolConsumerKey({ label: "" })).toBeNull();
    expect(createAccountPoolConsumerKey({ label: "a".repeat(130) })).toBeNull();
    expect(createAccountPoolConsumerKey({ dailyTokenQuota: -100 })).toBeNull();
    expect(createAccountPoolConsumerKey({ dailyTokenQuota: 0 })).toBeNull();
    expect(
      createAccountPoolConsumerKey({ dailyTokenQuota: "invalid" }),
    ).toBeNull();
  });

  it("finds active key, disabled key, and unknown key", () => {
    const active = createAccountPoolConsumerKey({ label: "active-client" });
    const disabled = createAccountPoolConsumerKey({
      label: "disabled-client",
      enabled: false,
    });
    if (!active || !disabled) throw new Error("expected created keys");

    const foundActive = findAccountPoolConsumerByKey(active.key);
    expect(foundActive).not.toBeNull();
    expect(typeof foundActive).toBe("object");
    expect((foundActive as { id: string }).id).toBe(active.consumer.id);

    const foundDisabled = findAccountPoolConsumerByKey(disabled.key);
    expect(foundDisabled).toBe("disabled");

    const unknown = findAccountPoolConsumerByKey(
      "eliza_cp_nonexistentkey1234567890",
    );
    expect(unknown).toBeNull();
  });

  it("updates consumer key label, enabled status, and quota", () => {
    const created = createAccountPoolConsumerKey({
      label: "initial",
      dailyTokenQuota: 10_000,
    });
    if (!created) throw new Error("expected created key");

    const updated = updateAccountPoolConsumerKey(created.consumer.id, {
      label: "renamed",
      enabled: false,
      dailyTokenQuota: 25_000,
    });

    expect(updated).not.toBeNull();
    expect(updated).not.toBe("invalid");
    const pub = updated as typeof created.consumer;
    expect(pub.label).toBe("renamed");
    expect(pub.enabled).toBe(false);
    expect(pub.dailyTokenQuota).toBe(25_000);

    expect(
      updateAccountPoolConsumerKey(created.consumer.id, {
        dailyTokenQuota: -5,
      }),
    ).toBe("invalid");

    expect(
      updateAccountPoolConsumerKey("ck_missing", { label: "test" }),
    ).toBeNull();
  });

  it("rotates consumer key while preserving id and createdAt", () => {
    const created = createAccountPoolConsumerKey({ label: "rotatable" });
    if (!created) throw new Error("expected created key");
    const rotated = rotateAccountPoolConsumerKey(created.consumer.id);

    expect(rotated).not.toBeNull();
    if (!rotated) throw new Error("expected rotated key");
    expect(rotated.consumer.id).toBe(created.consumer.id);
    expect(rotated.consumer.createdAt).toBe(created.consumer.createdAt);
    expect(rotated.key).not.toBe(created.key);
    expect(rotated.consumer.keyPrefix).toBe(rotated.key.slice(0, 18));

    expect(findAccountPoolConsumerByKey(created.key)).toBeNull();
    const found = findAccountPoolConsumerByKey(rotated.key);
    expect(typeof found).toBe("object");
    expect((found as { id: string }).id).toBe(created.consumer.id);

    expect(rotateAccountPoolConsumerKey("ck_missing")).toBeNull();
  });

  it("strips credential headers and formats error responses", () => {
    const headers = new Headers({
      "x-api-key": "secret-key",
      authorization: "Bearer token",
      "content-type": "application/json",
    });

    const stripped = stripAccountPoolConsumerCredentialHeaders(headers);
    expect(stripped.has("x-api-key")).toBe(false);
    expect(stripped.has("authorization")).toBe(false);
    expect(stripped.get("content-type")).toBe("application/json");

    expect(anthropicAuthError("Auth failed")).toEqual({
      type: "error",
      error: { type: "authentication_error", message: "Auth failed" },
    });

    expect(anthropicQuotaError("Limit reached")).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: "Limit reached" },
    });
  });

  it("estimates reservation tokens from payload size and max_tokens", () => {
    const payload = {
      model: "claude-3-7-sonnet",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
    };
    const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    expect(estimateAnthropicRequestReservation(payload)).toBe(bytes + 1024);

    const noMax = { prompt: "test" };
    expect(estimateAnthropicRequestReservation(noMax)).toBe(
      Buffer.byteLength(JSON.stringify(noMax), "utf8"),
    );

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(estimateAnthropicRequestReservation(cyclic)).toBe(1);
  });
});

describe("usage extraction and streaming meter", () => {
  it("replaces cumulative streaming usage across multiple message_delta events without double counting", async () => {
    const wire =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":4,"cache_creation_input_tokens":6}}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":15,"cache_creation_input_tokens":8}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":25,"cache_creation_input_tokens":12}}\n\n' +
      "data: [DONE]\n\n";
    const result = await pipeMeteredSse([wire]);
    expect(result.observed).toEqual([
      {
        input_tokens: 10,
        output_tokens: 25,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 12,
      },
    ]);
  });
  it("extracts non-stream usage from Anthropic response JSON", () => {
    expect(
      extractAnthropicUsageFromJson({
        usage: {
          input_tokens: 3,
          output_tokens: 5,
          cache_read_input_tokens: 7,
          cache_creation_input_tokens: 11,
        },
      }),
    ).toEqual({
      input_tokens: 3,
      output_tokens: 5,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 11,
    });
  });

  it("tees streaming SSE bytes unchanged across arbitrary chunk boundaries", async () => {
    const wire =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":13,"cache_read_input_tokens":17,"cache_creation_input_tokens":19}}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":23}}\n\n' +
      "data: [DONE]\n\n";
    const result = await pipeMeteredSse([
      wire.slice(0, 9),
      wire.slice(9, 47),
      wire.slice(47, 113),
      wire.slice(113),
    ]);
    expect(result.output).toBe(wire);
    expect(result.observed).toEqual([
      {
        input_tokens: 13,
        output_tokens: 23,
        cache_read_input_tokens: 17,
        cache_creation_input_tokens: 19,
      },
    ]);
  });

  it("finalizes partial observed usage exactly once after an abnormal stream end", async () => {
    const observed: unknown[] = [];
    const stream = createAnthropicSseUsageMeter((usage) => {
      observed.push(usage);
    });
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const chunk = new TextEncoder().encode(
      'data: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\n',
    );
    const read = reader.read();
    await writer.write(chunk);
    await read;
    await writer.abort(new Error("client disconnected"));
    await stream.finalizeUsage();
    await stream.finalizeUsage();

    expect(observed).toEqual([
      {
        input_tokens: 7,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    ]);
  });

  it("parses Anthropic SSE message_start and message_delta usage events", () => {
    const startPayload = {
      type: "message_start",
      message: {
        id: "msg_123",
        usage: {
          input_tokens: 45,
          cache_read_input_tokens: 15,
          cache_creation_input_tokens: 5,
        },
      },
    };
    expect(parseAnthropicSseEventUsage(startPayload)).toEqual({
      input_tokens: 45,
      cache_read_input_tokens: 15,
      cache_creation_input_tokens: 5,
    });

    const deltaPayload = {
      type: "message_delta",
      usage: {
        output_tokens: 80,
      },
    };
    expect(parseAnthropicSseEventUsage(deltaPayload)).toEqual({
      output_tokens: 80,
    });

    expect(
      parseAnthropicSseEventUsage({ type: "content_block_delta" }),
    ).toBeNull();
    expect(parseAnthropicSseEventUsage(null)).toBeNull();
  });
});

describe("consumer auth helper", () => {
  it("preserves legacy mode unless public consumer auth is explicitly enabled", async () => {
    delete process.env.ELIZA_ACCOUNT_POOL_CONSUMER_AUTH_ENABLED;
    const auth = await authenticateAccountPoolConsumerRequest(
      {
        authorization: "Bearer caller-key",
        "x-api-key": "caller-key",
        "anthropic-version": "2023-06-01",
      },
      { max_tokens: 32, messages: [] },
    );
    expect(auth.ok).toBe(true);
    if (!auth.ok) throw new Error("unexpected auth failure");
    expect(auth.mode).toBe("legacy");
    expect(auth.upstreamHeaders.has("authorization")).toBe(false);
    expect(auth.upstreamHeaders.has("x-api-key")).toBe(false);
    expect(auth.upstreamHeaders.get("anthropic-version")).toBe("2023-06-01");
  });

  it("returns Anthropic-shaped 401 for unknown and disabled keys and strips credentials", async () => {
    const disabled = createAccountPoolConsumerKey({
      label: "off",
      enabled: false,
    });
    if (!disabled) throw new Error("failed to create disabled key");

    const unknown = await authenticateAccountPoolConsumerRequest(
      {
        authorization: "Bearer not-real",
        "x-api-key": "not-real",
        "anthropic-version": "2023-06-01",
      },
      { max_tokens: 32, messages: [] },
    );
    if (unknown.ok) throw new Error("unexpected unknown-key auth success");
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.type).toBe("authentication_error");
    expect(unknown.upstreamHeaders.has("authorization")).toBe(false);
    expect(unknown.upstreamHeaders.has("x-api-key")).toBe(false);

    const blocked = await authenticateAccountPoolConsumerRequest(
      { authorization: `Bearer ${disabled.key}` },
      { max_tokens: 32, messages: [] },
    );
    if (blocked.ok) throw new Error("unexpected disabled-key auth success");
    expect(blocked.status).toBe(401);
  });

  it("does not treat the broker admin bearer as a consumer key", async () => {
    const auth = await authenticateAccountPoolConsumerRequest(
      { authorization: "Bearer admin-broker-secret-admin-broker-secret" },
      { max_tokens: 32, messages: [] },
    );
    if (auth.ok) throw new Error("unexpected admin-bearer auth success");
    expect(auth.status).toBe(401);
    expect(auth.body.error.type).toBe("authentication_error");
  });

  it("reserves the conservative request size before upstream admission", async () => {
    const created = createAccountPoolConsumerKey({
      label: "request-sized-quota",
      dailyTokenQuota: 100,
    });
    if (!created) throw new Error("failed to create key");

    const auth = await authenticateAccountPoolConsumerRequest(
      { "x-api-key": created.key },
      { max_tokens: 80, messages: [] },
    );
    expect(auth).toMatchObject({
      ok: false,
      status: 429,
      body: { error: { type: "rate_limit_error" } },
    });
  });
});

describe("quota and totals", () => {
  it("fail-closes only explicit daily quotas with Anthropic-shaped 429", async () => {
    const created = createAccountPoolConsumerKey({
      label: "quota",
      dailyTokenQuota: 10,
    });
    if (!created) throw new Error("failed to create key");
    const first = await admitAccountPoolConsumerRequest(created.consumer);
    if ("ok" in first) throw new Error("unexpected quota failure");
    await recordAccountPoolConsumerUsage({
      consumerId: created.consumer.id,
      consumerLabel: created.consumer.label,
      model: "claude-test",
      streaming: false,
      status: 200,
      latencyMs: 12,
      usage: {
        input_tokens: 4,
        output_tokens: 3,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1,
      },
      admission: first,
    });
    const second = await admitAccountPoolConsumerRequest(created.consumer);
    expect(second).toMatchObject({
      ok: false,
      status: 429,
      body: { error: { type: "rate_limit_error" } },
    });

    const authenticated = await authenticateAccountPoolConsumerRequest(
      { "x-api-key": created.key },
      { max_tokens: 1, messages: [] },
    );
    expect(authenticated).toMatchObject({
      ok: false,
      status: 429,
      body: { error: { type: "rate_limit_error" } },
    });
  });

  it("persists quota reservations across process-local state resets", async () => {
    const created = createAccountPoolConsumerKey({
      label: "durable-quota",
      dailyTokenQuota: 1,
    });
    if (!created) throw new Error("failed to create key");
    const first = await admitAccountPoolConsumerRequest(created.consumer);
    if ("ok" in first) throw new Error("unexpected quota failure");

    __resetAccountPoolConsumerMeteringForTests();

    const second = await admitAccountPoolConsumerRequest(created.consumer);
    expect(second).toMatchObject({
      ok: false,
      status: 429,
      body: { error: { type: "rate_limit_error" } },
    });
  });

  it("serializes concurrent totals updates without losing records", async () => {
    const created = createAccountPoolConsumerKey({ label: "concurrent" });
    if (!created) throw new Error("failed to create key");
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        recordAccountPoolConsumerUsage({
          ts: 1_800_000_000_000 + index,
          consumerId: created.consumer.id,
          consumerLabel: created.consumer.label,
          model: "claude-test",
          streaming: index % 2 === 0,
          status: 200,
          latencyMs: 1,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_read_input_tokens: 1,
            cache_creation_input_tokens: 0,
          },
        }),
      ),
    );
    const usage = await queryAccountPoolConsumerUsage({
      consumerId: created.consumer.id,
    });
    expect(usage.totals.requests).toBe(50);
    expect(usage.totals.tokens).toBe(150);
    expect(usage.records).toHaveLength(50);

    const summary = await getAccountPoolConsumerUsageSummary();
    expect(summary.totals).toMatchObject({ requests: 50, tokens: 150 });
    expect(summary.byConsumer[created.consumer.id]).toMatchObject({
      requests: 50,
      tokens: 150,
    });
    expect(summary.records).toEqual([]);
  });

  it("enforces isolated daily quotas across multiple distinct consumers", async () => {
    const consumerA = createAccountPoolConsumerKey({
      label: "consumer-a",
      dailyTokenQuota: 50,
    });
    const consumerB = createAccountPoolConsumerKey({
      label: "consumer-b",
      dailyTokenQuota: 100,
    });
    if (!consumerA || !consumerB) throw new Error("failed to create consumers");

    // Consumer A spends 45 tokens
    const admissionA = await admitAccountPoolConsumerRequest(
      consumerA.consumer,
      10,
    );
    if ("ok" in admissionA)
      throw new Error("unexpected quota admission failure for A");
    await recordAccountPoolConsumerUsage({
      consumerId: consumerA.consumer.id,
      consumerLabel: consumerA.consumer.label,
      model: "claude-test",
      streaming: false,
      status: 200,
      latencyMs: 10,
      usage: {
        input_tokens: 25,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      admission: admissionA,
    });

    // Consumer A cannot admit 10 tokens (exceeds remaining quota 50 - 45 = 5)
    const secondA = await admitAccountPoolConsumerRequest(
      consumerA.consumer,
      10,
    );
    expect(secondA).toMatchObject({
      ok: false,
      status: 429,
      body: { error: { type: "rate_limit_error" } },
    });

    // Consumer B is completely unaffected and has its own independent 100 token quota
    const admissionB = await admitAccountPoolConsumerRequest(
      consumerB.consumer,
      60,
    );
    if ("ok" in admissionB) throw new Error("unexpected quota rejection for B");

    await recordAccountPoolConsumerUsage({
      consumerId: consumerB.consumer.id,
      consumerLabel: consumerB.consumer.label,
      model: "claude-test",
      streaming: false,
      status: 200,
      latencyMs: 20,
      usage: {
        input_tokens: 30,
        output_tokens: 30,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      admission: admissionB,
    });

    // Per-consumer summaries remain isolated
    const summary = await getAccountPoolConsumerUsageSummary();
    expect(summary.byConsumer[consumerA.consumer.id]).toMatchObject({
      requests: 1,
      tokens: 45,
    });
    expect(summary.byConsumer[consumerB.consumer.id]).toMatchObject({
      requests: 1,
      tokens: 60,
    });
    expect(summary.totals.requests).toBeGreaterThanOrEqual(2);
    expect(summary.totals.tokens).toBeGreaterThanOrEqual(105);
  });

  it("tracks per-dimension accumulator counters and error statuses in totals and byDay buckets", async () => {
    const created = createAccountPoolConsumerKey({
      label: "metered-accumulators",
    });
    if (!created) throw new Error("failed to create consumer");

    const fixedTs = 1_800_000_500_000;
    // Successful request: status 200
    await recordAccountPoolConsumerUsage({
      ts: fixedTs,
      consumerId: created.consumer.id,
      consumerLabel: created.consumer.label,
      model: "claude-test",
      streaming: false,
      status: 200,
      latencyMs: 15,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 3,
      },
    });

    // Failed request: status 400 (counted toward input tokens, requests, and errors)
    await recordAccountPoolConsumerUsage({
      ts: fixedTs + 1000,
      consumerId: created.consumer.id,
      consumerLabel: created.consumer.label,
      model: "claude-test",
      streaming: true,
      status: 400,
      latencyMs: 25,
      usage: {
        input_tokens: 4,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });

    const usage = await queryAccountPoolConsumerUsage({
      consumerId: created.consumer.id,
    });

    // Detailed per-dimension counters
    expect(usage.totals.requests).toBe(2);
    expect(usage.totals.tokens).toBe(42); // (10 + 20 + 5 + 3) + (4) = 42
    expect(usage.totals.input_tokens).toBe(14);
    expect(usage.totals.output_tokens).toBe(20);
    expect(usage.totals.cache_read_input_tokens).toBe(5);
    expect(usage.totals.cache_creation_input_tokens).toBe(3);
    expect(usage.totals.latencyMs).toBe(40); // 15 + 25 = 40
    expect(usage.totals.errors).toBe(1); // status >= 400 recorded as error

    const summary = await getAccountPoolConsumerUsageSummary();
    const consumerBucket = summary.byConsumer[created.consumer.id];
    expect(consumerBucket).toMatchObject({
      requests: 2,
      tokens: 42,
      input_tokens: 14,
      output_tokens: 20,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 3,
      latencyMs: 40,
      errors: 1,
    });
  });
});
