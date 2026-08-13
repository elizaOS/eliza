/**
 * Unit coverage for first-shared-turn cache-warming 503 absorption at the
 * request choke point (#18045). Transport stubbed, boot config injected, no
 * live model. Proves the client retries ONLY the two named warming codes with
 * the identical request body (same clientMessageId), honors Retry-After within
 * a bounded budget, and leaves a generic 503 / a 402 as real failures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBootConfig } from "../config/boot-config";
import { ElizaClient } from "./client-base";
import type { AgentRequestTransport } from "./transport";

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function warming503(code: string): Response {
  return jsonResponse(
    503,
    { error: "Cache is warming. Retry shortly.", code, retryable: true },
    { "retry-after": "1" },
  );
}

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

const SEND_BODY = JSON.stringify({
  text: "hi",
  clientMessageId: "cmid-stable-1",
});

describe("ElizaClient warming 503 absorption (#18045)", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("absorbs both named warming barriers and re-issues the identical body", async () => {
    const request = vi
      .fn<AgentRequestTransport["request"]>()
      .mockResolvedValueOnce(warming503("agent_cache_warming"))
      .mockResolvedValueOnce(warming503("shared_runtime_cache_warming"))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const client = makeClient(request);
    const pending = client.fetch<{ ok: boolean }>("/api/messages", {
      method: "POST",
      body: SEND_BODY,
    });
    await vi.runAllTimersAsync();
    const out = await pending;

    expect(request).toHaveBeenCalledTimes(3);
    // The retries are idempotent with the original attempt: byte-identical
    // body, so the same clientMessageId rides every re-issue.
    for (const call of request.mock.calls) {
      expect(call[1]?.body).toBe(SEND_BODY);
    }
    expect(out).toEqual(expect.objectContaining({ ok: true }));
  });

  it("does not retry a generic 503 without a warming code", async () => {
    const request = vi
      .fn<AgentRequestTransport["request"]>()
      .mockResolvedValue(
        jsonResponse(
          503,
          { error: "inference unavailable", code: "inference_unavailable" },
          { "retry-after": "1" },
        ),
      );

    const client = makeClient(request);
    let caught: unknown;
    const pending = client
      .fetch("/api/messages", { method: "POST", body: SEND_BODY })
      .catch((e) => {
        caught = e;
      });
    await vi.runAllTimersAsync();
    await pending;

    expect(request).toHaveBeenCalledTimes(1);
    expect((caught as { status?: number }).status).toBe(503);
    expect((caught as { code?: string }).code).toBe("inference_unavailable");
  });

  it("does not retry a 402 insufficient_credits gate", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>().mockResolvedValue(
      jsonResponse(402, {
        error: "Out of credits.",
        code: "insufficient_credits",
      }),
    );

    const client = makeClient(request);
    let caught: unknown;
    const pending = client
      .fetch("/api/messages", { method: "POST", body: SEND_BODY })
      .catch((e) => {
        caught = e;
      });
    await vi.runAllTimersAsync();
    await pending;

    expect(request).toHaveBeenCalledTimes(1);
    expect((caught as { status?: number }).status).toBe(402);
    expect((caught as { code?: string }).code).toBe("insufficient_credits");
  });

  it("stops after the bounded budget and surfaces the structured warming error", async () => {
    // A fresh Response per call — a Response body is single-read, and the
    // warming classifier reads it on every attempt.
    const request = vi
      .fn<AgentRequestTransport["request"]>()
      .mockImplementation(() =>
        Promise.resolve(warming503("shared_runtime_cache_warming")),
      );

    const client = makeClient(request);
    let caught: unknown;
    const pending = client
      .fetch("/api/messages", { method: "POST", body: SEND_BODY })
      .catch((e) => {
        caught = e;
      });
    await vi.runAllTimersAsync();
    await pending;

    // 1 initial attempt + 4 bounded retries = 5 total; it does not loop forever.
    expect(request).toHaveBeenCalledTimes(5);
    expect((caught as { status?: number }).status).toBe(503);
    expect((caught as { code?: string }).code).toBe(
      "shared_runtime_cache_warming",
    );
    expect((caught as { retryAfter?: number }).retryAfter).toBe(1);
  });

  it("stops retrying when the caller aborts mid-wait", async () => {
    const controller = new AbortController();
    const request = vi
      .fn<AgentRequestTransport["request"]>()
      .mockResolvedValue(warming503("agent_cache_warming"));

    const client = makeClient(request);
    const pending = client
      .fetch("/api/messages", {
        method: "POST",
        body: SEND_BODY,
        signal: controller.signal,
      })
      .catch(() => undefined);
    controller.abort();
    await vi.runAllTimersAsync();
    await pending;

    expect(request).toHaveBeenCalledTimes(1);
  });
});
