/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves meeting hops carry timeoutMs into Agent.request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import {
  MEETINGS_GET_FETCH_TIMEOUT_MS,
  MEETINGS_LIST_FETCH_TIMEOUT_MS,
  MEETINGS_REQUEST_FETCH_TIMEOUT_MS,
} from "./client-meetings";
import "./client-meetings";
import type { AgentRequestTransport } from "./transport";
import { setBootConfig } from "../config/boot-config";

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

describe("ElizaClient meeting native transport", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("forwards the request deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ session: { id: "m1" } }),
    );
    await makeClient(request).requestMeetingBot({
      platform: "zoom",
      meetingUrl: "https://zoom.example/j/1",
    });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/meetings",
      expect.any(Object),
      { timeoutMs: MEETINGS_REQUEST_FETCH_TIMEOUT_MS },
    );
  });

  it("forwards the list deadline to Agent.request", async () => {
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

  it("forwards the get deadline to Agent.request", async () => {
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

  it("times out a stalled get hop through ElizaClient", async () => {
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
    await expect(makeClient(request).getMeeting("m1", 10)).rejects.toMatchObject({
      name: "ApiError",
      kind: "timeout",
    });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/meetings/m1",
      expect.any(Object),
      { timeoutMs: 10 },
    );
  });
});
