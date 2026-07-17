/**
 * Focused tests for the account-pool consumer-key and metering contract. The
 * harness uses a temp state directory and does not touch provider transport:
 * parser tests feed raw SSE bytes, auth tests inspect stripped headers, and
 * storage tests exercise the durable JSONL/totals path.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetAccountPoolConsumerMeteringForTests,
  admitAccountPoolConsumerRequest,
  authenticateAccountPoolConsumerRequest,
  createAccountPoolConsumerKey,
  createAnthropicSseUsageMeter,
  extractAnthropicUsageFromJson,
  getAccountPoolConsumerUsageSummary,
  queryAccountPoolConsumerUsage,
  recordAccountPoolConsumerUsage,
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
  const outputPromise = (async () => {
    let output = "";
    while (true) {
      const read = await reader.read();
      if (read.done) return output;
      output += decoder.decode(read.value, { stream: true });
    }
  })();
  for (const chunk of chunks) {
    await writer.write(encoder.encode(chunk));
  }
  await writer.close();
  return {
    output: await outputPromise,
    observed,
  };
}

describe("Anthropic usage extraction", () => {
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
});
