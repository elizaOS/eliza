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
