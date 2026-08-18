/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves the HTTP fallback of getBrowserWorkspace carries timeoutMs into
 * Agent.request (desktop Electrobun RPC path is unchanged).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import { BROWSER_WORKSPACE_GET_FETCH_TIMEOUT_MS } from "./client-browser-workspace";
import "./client-browser-workspace";
import type { AgentRequestTransport } from "./transport";
import { setBootConfig } from "../config/boot-config";

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

const snapshot = { mode: "web", tabs: [] };

describe("ElizaClient browser-workspace native-complete deadlines", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("keeps a documented budget for the get hop", () => {
    expect(BROWSER_WORKSPACE_GET_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("forwards the get deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json(snapshot),
    );
    await makeClient(request).getBrowserWorkspace();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/browser-workspace",
      expect.any(Object),
      { timeoutMs: BROWSER_WORKSPACE_GET_FETCH_TIMEOUT_MS },
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
    await expect(
      makeClient(request).getBrowserWorkspace(10),
    ).rejects.toMatchObject({
      name: "ApiError",
      kind: "timeout",
    });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/browser-workspace",
      expect.any(Object),
      { timeoutMs: 10 },
    );
  });

  it("surfaces a provider error from a completed get GET", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(
      async () =>
        new Response(JSON.stringify({ error: "unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(
      makeClient(request).getBrowserWorkspace(),
    ).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
    });
  });
});
