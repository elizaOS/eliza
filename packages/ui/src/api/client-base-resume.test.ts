/**
 * Unit coverage for chat stream resume on the base client. Transport stubbed,
 * boot config injected, no live model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBootConfig } from "../config/boot-config";
import { ElizaClient } from "./client-base";
import "./client-chat";
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

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

describe("ElizaClient 202 dedicated-agent resume handling", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits Retry-After and retries a 202 until the agent resumes", async () => {
    const request = vi
      .fn<AgentRequestTransport["request"]>()
      .mockResolvedValueOnce(
        jsonResponse(202, { resuming: true }, { "retry-after": "1" }),
      )
      .mockResolvedValueOnce(
        jsonResponse(202, { resuming: true }, { "retry-after": "1" }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { agentName: "Eliza", ok: true }),
      );

    const client = makeClient(request);
    const pending = client.fetch<{ ok: boolean }>("/api/status");
    await vi.runAllTimersAsync();
    const out = await pending;

    expect(request).toHaveBeenCalledTimes(3);
    expect(out).toEqual(expect.objectContaining({ ok: true }));
  });

  it("does not retry a normal 200 response (ordinary requests unaffected)", async () => {
    const request = vi
      .fn<AgentRequestTransport["request"]>()
      .mockResolvedValue(jsonResponse(200, { ok: true }));

    const client = makeClient(request);
    await client.fetch("/api/status");

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("throws a distinguishable agent_resuming error after the bounded retries", async () => {
    const request = vi
      .fn<AgentRequestTransport["request"]>()
      .mockResolvedValue(
        jsonResponse(202, { resuming: true }, { "retry-after": "1" }),
      );

    const client = makeClient(request);
    let caught: unknown;
    const pending = client.fetch("/api/status").catch((e) => {
      caught = e;
    });
    await vi.runAllTimersAsync();
    await pending;

    // 1 initial attempt + 6 bounded retries = 7 total; it does not loop forever.
    expect(request).toHaveBeenCalledTimes(7);
    // ...and it surfaces a typed 202 "resuming" error instead of returning the
    // empty 202 placeholder as a (silent) success.
    expect(caught).toBeTruthy();
    expect((caught as { status?: number }).status).toBe(202);
    expect((caught as { code?: string }).code).toBe("agent_resuming");
  });

  it("stops waiting when the caller aborts mid-resume", async () => {
    const controller = new AbortController();
    const request = vi
      .fn<AgentRequestTransport["request"]>()
      .mockResolvedValue(
        jsonResponse(202, { resuming: true }, { "retry-after": "5" }),
      );

    const client = makeClient(request);
    const pending = client
      .fetch("/api/status", { signal: controller.signal })
      .catch(() => undefined);
    // abort while waiting on the first Retry-After delay
    controller.abort();
    await vi.runAllTimersAsync();
    await pending;

    // initial attempt happened; the abort prevents further resume retries
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("ElizaClient shared-agent warming retry", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("retries only the two structured warming codes with the same body", async () => {
    const request = vi
      .fn<AgentRequestTransport["request"]>()
      .mockResolvedValueOnce(
        jsonResponse(
          503,
          { code: "agent_cache_warming" },
          { "retry-after": "1" },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          503,
          { code: "shared_runtime_cache_warming" },
          { "retry-after": "1" },
        ),
      )
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const body = JSON.stringify({ text: "hello", clientMessageId: "turn-1" });
    const pending = makeClient(request).fetch("/api/chat/stream", {
      method: "POST",
      body,
    });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.map((call) => call[1]?.body)).toEqual([
      body,
      body,
      body,
    ]);
  });

  it("stops after three warming retries", async () => {
    const request = vi
      .fn<AgentRequestTransport["request"]>()
      .mockResolvedValue(
        jsonResponse(
          503,
          { code: "shared_runtime_cache_warming" },
          { "retry-after": "0" },
        ),
      );
    const pending = makeClient(request)
      .fetch("/api/chat/stream")
      .catch((error) => error);
    await vi.runAllTimersAsync();
    expect(((await pending) as { code?: string }).code).toBe(
      "shared_runtime_cache_warming",
    );
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("uses the one-second default when Retry-After is absent", async () => {
    const request = vi
      .fn<AgentRequestTransport["request"]>()
      .mockResolvedValueOnce(
        jsonResponse(503, { code: "shared_runtime_cache_warming" }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const pending = makeClient(request).fetch<{ ok: boolean }>(
      "/api/chat/stream",
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([402, 409, 503])("does not retry an unrelated %s", async (status) => {
    const body =
      status === 402
        ? { code: "insufficient_credits" }
        : status === 409
          ? { code: "shared_runtime_idempotency_conflict", retryable: false }
          : { code: "inference_unavailable", retryable: true };
    const request = vi
      .fn<AgentRequestTransport["request"]>()
      .mockResolvedValue(jsonResponse(status, body));
    await makeClient(request)
      .fetch("/api/chat/stream")
      .catch(() => undefined);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
