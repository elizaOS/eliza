/** Verifies meeting hops pass timeoutMs through ElizaClient.fetch. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import {
  MEETINGS_GET_FETCH_TIMEOUT_MS,
  MEETINGS_LIST_FETCH_TIMEOUT_MS,
  MEETINGS_REQUEST_FETCH_TIMEOUT_MS,
  MEETINGS_STOP_FETCH_TIMEOUT_MS,
} from "./client-meetings";
import "./client-meetings";
import type { AgentRequestTransport } from "./transport";
import { setBootConfig } from "../config/boot-config";

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

const join = {
  platform: "zoom" as const,
  meetingUrl: "https://zoom.example/j/1",
};

describe("ElizaClient meeting native-complete deadlines", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("keeps a documented budget per hop", () => {
    expect(MEETINGS_REQUEST_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(MEETINGS_LIST_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(MEETINGS_GET_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(MEETINGS_STOP_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("passes request timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ session: { id: "m1" } }),
    );
    await makeClient(request).requestMeetingBot(join);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/meetings",
      expect.any(Object),
      { timeoutMs: MEETINGS_REQUEST_FETCH_TIMEOUT_MS },
    );
  });

  it("passes list timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ sessions: [] }),
    );
    await makeClient(request).listMeetings();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/meetings",
      expect.any(Object),
      { timeoutMs: MEETINGS_LIST_FETCH_TIMEOUT_MS },
    );
  });

  it("keeps ?active=1 and passes list timeoutMs on that hop", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ sessions: [] }),
    );
    await makeClient(request).listMeetings({ active: true });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/meetings?active=1",
      expect.any(Object),
      { timeoutMs: MEETINGS_LIST_FETCH_TIMEOUT_MS },
    );
  });

  it("passes get timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ session: { id: "m1" } }),
    );
    await makeClient(request).getMeeting("m1");
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/meetings/m1",
      expect.any(Object),
      { timeoutMs: MEETINGS_GET_FETCH_TIMEOUT_MS },
    );
  });

  it("passes stop timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ ok: true }),
    );
    await makeClient(request).stopMeeting("m1");
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/meetings/m1",
      expect.any(Object),
      { timeoutMs: MEETINGS_STOP_FETCH_TIMEOUT_MS },
    );
  });

  it("aborts a stalled stop hop as TimeoutError", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(
      async (_url, init, ctx) => {
        const ms = ctx?.timeoutMs ?? 10;
        await new Promise<never>((_, reject) => {
          const timer = setTimeout(() => {
            reject(
              Object.assign(new Error(`Request timed out after ${ms}ms`), {
                name: "TimeoutError",
              }),
            );
          }, ms);
          init.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(
                Object.assign(new Error("The operation was aborted"), {
                  name: "AbortError",
                }),
              );
            },
            { once: true },
          );
        });
      },
    );
    await expect(makeClient(request).stopMeeting("m1", 10)).rejects.toMatchObject(
      { name: "ApiError", kind: "timeout" },
    );
  });

  it("surfaces a provider error from a completed list GET", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(
      async () =>
        new Response(JSON.stringify({ error: "unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(makeClient(request).listMeetings()).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
    });
  });
});
