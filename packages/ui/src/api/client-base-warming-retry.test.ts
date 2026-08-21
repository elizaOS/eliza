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

  it("marks the first shared turn and each absorbed warming retry", async () => {
    const request = vi
      .fn<AgentRequestTransport["request"]>()
      .mockResolvedValueOnce(warming503("shared_runtime_cache_warming"))
      .mockResolvedValueOnce(
        new Response('event: done\ndata: {"text":"ok"}\n\n', {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    const client = makeClient(request);
    const pending = client.streamChatEndpoint(
      "/api/conversations/c-1/messages/stream",
      "hi",
      () => undefined,
      "DM",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "caller-stable-id",
    );
    await vi.runAllTimersAsync();
    await pending;

    expect(request).toHaveBeenCalledTimes(2);
    const firstHeaders = new Headers(request.mock.calls[0]?.[1]?.headers);
    const retryHeaders = new Headers(request.mock.calls[1]?.[1]?.headers);
    const correlation = firstHeaders.get("X-ElizaOS-Turn-Correlation");
    expect(correlation).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(correlation).not.toBe("caller-stable-id");
    expect(retryHeaders.get("X-ElizaOS-Turn-Correlation")).toBe(correlation);
    expect(firstHeaders.get("X-ElizaOS-Turn-Attempt")).toBe("1");
    expect(retryHeaders.get("X-ElizaOS-Turn-Attempt")).toBe("2");
    for (const call of request.mock.calls) {
      expect(JSON.parse(String(call[1]?.body))).toMatchObject({
        clientMessageId: "caller-stable-id",
      });
    }
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

describe("ElizaClient unified response classification loop (#19186 CR)", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the 202 resume contract after an absorbed warming 503 (no placeholder success)", async () => {
    const request = vi
      .fn<AgentRequestTransport["request"]>()
      .mockResolvedValueOnce(warming503("agent_cache_warming"))
      .mockResolvedValueOnce(
        jsonResponse(202, { resuming: true }, { "retry-after": "1" }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const client = makeClient(request);
    const pending = client.fetch<{ ok: boolean }>("/api/messages", {
      method: "POST",
      body: SEND_BODY,
    });
    await vi.runAllTimersAsync();
    const out = await pending;

    // warming retry → 202 → resume retry → 200; the 202 placeholder body is
    // never surfaced as the reply.
    expect(request).toHaveBeenCalledTimes(3);
    expect(out).toEqual(expect.objectContaining({ ok: true }));
  });

  it("refreshes the token on a 401 that follows an absorbed warming 503", async () => {
    const client = new ElizaClient("http://agent.example:2138");
    const request = vi
      .fn<AgentRequestTransport["request"]>()
      .mockResolvedValueOnce(warming503("agent_cache_warming"))
      .mockImplementationOnce(() => {
        // The token lands mid-flight (login race): the refresh path must pick
        // it up and the retry must carry it.
        client.setToken("fresh-token");
        return Promise.resolve(
          jsonResponse(401, { error: "Unauthorized", code: "unauthorized" }),
        );
      })
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    client.setRequestTransport({ request });

    const pending = client.fetch<{ ok: boolean }>("/api/messages", {
      method: "POST",
      body: SEND_BODY,
    });
    await vi.runAllTimersAsync();
    const out = await pending;

    expect(request).toHaveBeenCalledTimes(3);
    expect(out).toEqual(expect.objectContaining({ ok: true }));
    const headersOf = (call: number) =>
      request.mock.calls[call][1]?.headers as Record<string, string>;
    expect(headersOf(1).Authorization).toBeUndefined();
    expect(headersOf(2).Authorization).toBe("Bearer fresh-token");
  });

  it("uses the refreshed token — not the stale one — for warming retries after a 401", async () => {
    const client = new ElizaClient("http://agent.example:2138");
    const request = vi
      .fn<AgentRequestTransport["request"]>()
      .mockImplementationOnce(() => {
        client.setToken("fresh-token");
        return Promise.resolve(
          jsonResponse(401, { error: "Unauthorized", code: "unauthorized" }),
        );
      })
      .mockResolvedValueOnce(warming503("shared_runtime_cache_warming"))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    client.setRequestTransport({ request });

    const pending = client.fetch<{ ok: boolean }>("/api/messages", {
      method: "POST",
      body: SEND_BODY,
    });
    await vi.runAllTimersAsync();
    const out = await pending;

    expect(request).toHaveBeenCalledTimes(3);
    expect(out).toEqual(expect.objectContaining({ ok: true }));
    const headersOf = (call: number) =>
      request.mock.calls[call][1]?.headers as Record<string, string>;
    // Post-refresh retries (including the warming re-issue) all carry the
    // refreshed credential.
    expect(headersOf(1).Authorization).toBe("Bearer fresh-token");
    expect(headersOf(2).Authorization).toBe("Bearer fresh-token");
    // The re-issued body is still byte-identical (same clientMessageId).
    for (const call of request.mock.calls) {
      expect(call[1]?.body).toBe(SEND_BODY);
    }
  });

  it("stops when the caller aborts during the 202 resume wait that follows warming", async () => {
    const controller = new AbortController();
    const request = vi
      .fn<AgentRequestTransport["request"]>()
      .mockResolvedValueOnce(warming503("agent_cache_warming"))
      .mockResolvedValue(
        jsonResponse(202, { resuming: true }, { "retry-after": "5" }),
      );

    const client = makeClient(request);
    const pending = client
      .fetch("/api/messages", {
        method: "POST",
        body: SEND_BODY,
        signal: controller.signal,
      })
      .catch(() => undefined);
    // Let the warming wait elapse so the 202 arrives, then abort during the
    // resume wait.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(2);
    controller.abort();
    await vi.runAllTimersAsync();
    await pending;

    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["missing", undefined, 1_000],
    ["integer seconds", "1", 1_000],
    ["fractional", "0.25", 250],
    ["negative", "-1", 250],
    ["malformed", "nope", 1_000],
    ["empty", "", 250],
  ] as const)(
    "clamps a %s Retry-After into the bounded warming wait",
    async (_label, header, expectedMs) => {
      const request = vi
        .fn<AgentRequestTransport["request"]>()
        .mockResolvedValueOnce(
          jsonResponse(
            503,
            {
              error: "Cache is warming. Retry shortly.",
              code: "agent_cache_warming",
              retryable: true,
            },
            header === undefined ? {} : { "retry-after": header },
          ),
        )
        .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

      const client = makeClient(request);
      const pending = client.fetch<{ ok: boolean }>("/api/messages", {
        method: "POST",
        body: SEND_BODY,
      });
      await vi.advanceTimersByTimeAsync(expectedMs - 1);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(2);
      await expect(pending).resolves.toEqual(
        expect.objectContaining({ ok: true }),
      );
    },
  );

  it("caps TOTAL absorbed wait at the ~5s elapsed budget for an oversized Retry-After", async () => {
    const request = vi
      .fn<AgentRequestTransport["request"]>()
      .mockImplementation(() =>
        Promise.resolve(
          jsonResponse(
            503,
            {
              error: "Cache is warming. Retry shortly.",
              code: "agent_cache_warming",
              retryable: true,
            },
            { "retry-after": "60" },
          ),
        ),
      );

    const client = makeClient(request);
    const started = Date.now();
    let caught: unknown;
    const pending = client
      .fetch("/api/messages", { method: "POST", body: SEND_BODY })
      .catch((e) => {
        caught = e;
      });
    await vi.runAllTimersAsync();
    await pending;

    // One clamped wait consumes the whole elapsed budget: 1 initial attempt +
    // 1 retry at the deadline — NOT 4 × 5s.
    expect(request).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBe(5_000);
    expect((caught as { status?: number }).status).toBe(503);
    expect((caught as { code?: string }).code).toBe("agent_cache_warming");
  });
});
