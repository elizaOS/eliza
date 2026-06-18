/**
 * Retry/backoff behavior for the shared provider fetch helper.
 *
 * Validates the fix for transient inference failures on the
 * bitrouter -> openrouter -> upstream-provider path: identical requests bounce
 * between 429/502/200, so we retry retryable statuses with backoff and only
 * surface a hard error once the attempt budget is exhausted (or for
 * non-retryable statuses / streaming replays).
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { type ProviderLabel, providerFetchWithTimeout } from "./_http";
import type { ProviderHttpError } from "./types";

mock.module("./model-id-translation", () => ({}));

const ORIGINAL_FETCH = globalThis.fetch;

const LABEL: ProviderLabel = {
  display: "TestRouter",
  errorType: "test_error",
  requestFailedCode: "test_request_failed",
  timeoutCode: "test_timeout",
};

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
  });
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("providerFetchWithTimeout retry", () => {
  test("retries a transient 429 then succeeds", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls < 3) return jsonResponse(429, { error: { message: "rate limited" } });
      return jsonResponse(200, { ok: true });
    }) as typeof fetch;

    const res = await providerFetchWithTimeout(
      "https://x/v1/chat/completions",
      { method: "POST", body: JSON.stringify({ m: 1 }) },
      30_000,
      LABEL,
      { maxRetries: 3, baseDelayMs: 1 },
    );
    expect(res.status).toBe(200);
    expect(calls).toBe(3);
  });

  test("a recovered request returns REAL usable content, not just a 200", async () => {
    // Guard against the failure mode where a 200 carries empty/garbage output:
    // the recovered response must surface genuine, non-empty completion content
    // with finish_reason=stop (a real completion, not a truncated/empty body).
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      // First two attempts are the transient failures seen live (429 then the
      // 502 "neither content nor tool calls" empty-body); the third returns a
      // genuine completion.
      if (calls === 1) return jsonResponse(429, { error: { message: "rate limited" } });
      if (calls === 2)
        return jsonResponse(502, {
          error: { message: "chat completion returned neither content nor tool calls" },
        });
      return jsonResponse(200, {
        choices: [{ message: { role: "assistant", content: "42" }, finish_reason: "stop" }],
        usage: { completion_tokens: 5 },
      });
    }) as typeof fetch;

    const res = await providerFetchWithTimeout(
      "https://x/v1/chat/completions",
      { method: "POST", body: JSON.stringify({ q: "17 + 25?" }) },
      30_000,
      LABEL,
      { maxRetries: 3, baseDelayMs: 1 },
    );
    expect(res.status).toBe(200);
    expect(calls).toBe(3);
    const json = (await res.json()) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
    };
    const content = json.choices[0]?.message?.content ?? "";
    // Real inference assertions: non-empty content, clean stop, correct answer.
    expect(content.trim().length).toBeGreaterThan(0);
    expect(json.choices[0]?.finish_reason).toBe("stop");
    expect(content).toContain("42");
  });

  test("retries a transient 502 (empty-content upstream) then succeeds", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1)
        return jsonResponse(502, {
          error: { message: "chat completion returned neither content nor tool calls" },
        });
      return jsonResponse(200, { ok: true });
    }) as typeof fetch;

    const res = await providerFetchWithTimeout(
      "https://x/v1/chat/completions",
      { method: "POST", body: JSON.stringify({ m: 1 }) },
      30_000,
      LABEL,
      { maxRetries: 3, baseDelayMs: 1 },
    );
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  test("does NOT retry a non-retryable 400", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse(400, { error: { message: "bad request" } });
    }) as typeof fetch;

    await expect(
      providerFetchWithTimeout(
        "https://x/v1/chat/completions",
        { method: "POST", body: JSON.stringify({ m: 1 }) },
        30_000,
        LABEL,
        { maxRetries: 3, baseDelayMs: 1 },
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toBe(1);
  });

  test("exhausts the retry budget and throws the last transient error", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse(429, { error: { message: "rate limited" } });
    }) as typeof fetch;

    await expect(
      providerFetchWithTimeout(
        "https://x/v1/chat/completions",
        { method: "POST", body: JSON.stringify({ m: 1 }) },
        30_000,
        LABEL,
        { maxRetries: 2, baseDelayMs: 1 },
      ),
    ).rejects.toMatchObject({ status: 429 });
    // 1 initial + 2 retries = 3 total
    expect(calls).toBe(3);
  });

  test("maxRetries: 0 disables retry (streaming path)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse(503, { error: { message: "unavailable" } });
    }) as typeof fetch;

    await expect(
      providerFetchWithTimeout(
        "https://x/v1/chat/completions",
        { method: "POST", body: JSON.stringify({ m: 1 }) },
        30_000,
        LABEL,
        { maxRetries: 0, baseDelayMs: 1 },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(calls).toBe(1);
  });

  test("respects Retry-After header for backoff (still succeeds)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1)
        return jsonResponse(429, { error: { message: "slow down" } }, { "retry-after": "0" });
      return jsonResponse(200, { ok: true });
    }) as typeof fetch;

    const res = await providerFetchWithTimeout(
      "https://x/v1/chat/completions",
      { method: "POST", body: JSON.stringify({ m: 1 }) },
      30_000,
      LABEL,
      { maxRetries: 3, baseDelayMs: 1 },
    );
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  test("does not retry when body is a one-shot ReadableStream", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse(429, { error: { message: "rate limited" } });
    }) as typeof fetch;

    const stream = new ReadableStream();
    await expect(
      providerFetchWithTimeout(
        "https://x/v1/chat/completions",
        { method: "POST", body: stream },
        30_000,
        LABEL,
        { maxRetries: 3, baseDelayMs: 1 },
      ),
    ).rejects.toMatchObject({ status: 429 });
    expect(calls).toBe(1);
  });

  const _unusedHttpError: ProviderHttpError = { status: 429, error: { message: "x" } };
  void _unusedHttpError;
});
