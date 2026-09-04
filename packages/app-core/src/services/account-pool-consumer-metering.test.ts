/**
 * Focused tests for the account-pool consumer-key and metering contract. The
 * harness uses a temp state directory and does not touch provider transport:
 * parser tests feed raw SSE bytes, auth tests inspect stripped headers, and
 * storage tests exercise the durable JSONL/totals path.
 */
import { appendFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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

describe("a damaged usage-log line", () => {
  // The log is append-only and `readUsageRecords` runs on the admission path,
  // so a line this process did not finish writing must not be able to fail —
  // or silently pass — the quota gate.

  function usageDirPath(): string {
    return path.join(stateDir, "account-pool", "consumer-usage");
  }

  function appendRawLine(bytes: string): void {
    const files = readdirSync(usageDirPath());
    if (files.length !== 1) throw new Error("expected exactly one usage file");
    appendFileSync(path.join(usageDirPath(), files[0]), bytes);
  }

  async function seedRecord(consumerId: string, tokens: number): Promise<void> {
    await recordAccountPoolConsumerUsage({
      ts: 1_800_000_000_000,
      consumerId,
      consumerLabel: "damaged-line",
      model: "claude-test",
      streaming: false,
      status: 200,
      latencyMs: 5,
      usage: {
        input_tokens: tokens,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });
  }

  it("does not fail admission, and does not fail it forever", async () => {
    const created = createAccountPoolConsumerKey({
      label: "truncated",
      dailyTokenQuota: 1_000_000,
    });
    if (!created) throw new Error("failed to create key");
    await seedRecord(created.consumer.id, 10);

    // An append interrupted before its trailing newline.
    appendRawLine(`{"consumerId":"${created.consumer.id}","ts":1`);

    // Twice: the first call must not throw, and the row is left in place, so
    // the second must not throw either.
    for (const _attempt of [1, 2]) {
      const admission = await admitAccountPoolConsumerRequest(created.consumer);
      expect(admission).not.toHaveProperty("status", 429);
      expect(admission).toHaveProperty("consumerId", created.consumer.id);
    }
  });

  it("still reports every intact record in the same file", async () => {
    const created = createAccountPoolConsumerKey({ label: "partial-ledger" });
    if (!created) throw new Error("failed to create key");
    await seedRecord(created.consumer.id, 10);
    await seedRecord(created.consumer.id, 7);
    // Truncation strands the newline too, so the damaged bytes are last.
    appendRawLine('{"consumerId":"x","ts":1');

    const summary = await queryAccountPoolConsumerUsage({});
    // Liveness control: skipping the damaged line must not mean skipping the
    // ledger. Without this, every assertion above would pass just as well if
    // the reader returned nothing at all.
    expect(summary.records).toHaveLength(2);
    expect(summary.totals.tokens).toBe(17);
    expect(summary.totals.requests).toBe(2);
  });

  it("loses only the damaged line's own record, not the whole file", async () => {
    const created = createAccountPoolConsumerKey({ label: "one-line-lost" });
    if (!created) throw new Error("failed to create key");
    await seedRecord(created.consumer.id, 10);
    // A complete but unparseable line, newline intact, with a good record
    // after it.
    appendRawLine('{"consumerId":"x","ts":1\n');
    await seedRecord(created.consumer.id, 7);

    const summary = await queryAccountPoolConsumerUsage({});
    expect(summary.records).toHaveLength(2);
    expect(summary.totals.tokens).toBe(17);
  });

  const NON_CONFORMING: ReadonlyArray<
    readonly [string, Record<string, unknown>]
  > = [
    [
      "no totalTokens (a `reduce` over it would make the day total NaN)",
      {
        ts: 1_800_000_000_001,
        latencyMs: 1,
        status: 200,
        usage: {
          input_tokens: 1,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    ],
    [
      "no usage object",
      { ts: 1_800_000_000_001, totalTokens: 5, latencyMs: 1, status: 200 },
    ],
    [
      "usage present but a member missing",
      {
        ts: 1_800_000_000_001,
        totalTokens: 5,
        latencyMs: 1,
        status: 200,
        usage: {
          input_tokens: 1,
          output_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    ],
    [
      "no ts (would pass every day-window comparison)",
      {
        totalTokens: 5,
        latencyMs: 1,
        status: 200,
        usage: {
          input_tokens: 1,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    ],
    [
      "totalTokens is a string",
      {
        ts: 1_800_000_000_001,
        totalTokens: "5",
        latencyMs: 1,
        status: 200,
        usage: {
          input_tokens: 1,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    ],
  ];

  for (const [label, row] of NON_CONFORMING) {
    it(`is ignored by the usage summary: ${label}`, async () => {
      const created = createAccountPoolConsumerKey({ label: "shapeless" });
      if (!created) throw new Error("failed to create key");
      await seedRecord(created.consumer.id, 10);
      appendRawLine(
        `${JSON.stringify({ consumerId: created.consumer.id, ...row })}\n`,
      );

      const summary = await queryAccountPoolConsumerUsage({});
      expect(summary.records).toHaveLength(1);
      expect(summary.totals.tokens).toBe(10);
    });
  }

  it("cannot lift an exhausted quota", async () => {
    const created = createAccountPoolConsumerKey({
      label: "quota-bypass",
      dailyTokenQuota: 100,
    });
    if (!created) throw new Error("failed to create key");
    const day = new Date().toISOString().slice(0, 10);
    await recordAccountPoolConsumerUsage({
      consumerId: created.consumer.id,
      consumerLabel: created.consumer.label,
      model: "claude-test",
      streaming: false,
      status: 200,
      latencyMs: 1,
      usage: {
        input_tokens: 500,
        output_tokens: 500,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });
    expect(day).toBe(day);

    // Already far over quota.
    expect(
      await admitAccountPoolConsumerRequest(created.consumer),
    ).toMatchObject({ ok: false, status: 429 });

    // A single record with no `totalTokens` used to turn the day total into
    // NaN, and `NaN > quota` is `false` — the gate opened.
    appendRawLine(
      `${JSON.stringify({
        consumerId: created.consumer.id,
        ts: Date.now(),
        latencyMs: 1,
        status: 200,
        usage: {
          input_tokens: 1,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      })}\n`,
    );

    expect(
      await admitAccountPoolConsumerRequest(created.consumer),
    ).toMatchObject({ ok: false, status: 429 });
  });
});
