/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves the capability-router connect hop carries timeoutMs into Agent.request.
 * getConfig / updateConfig stay untouched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "../../api/client-base";
import type { AgentRequestTransport } from "../../api/transport";
import { setBootConfig } from "../../config/boot-config";
import {
  CAPABILITY_ROUTER_CONNECT_FETCH_TIMEOUT_MS,
  fetchCapabilityRouterConnect,
} from "./CapabilitiesSection";

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

describe("CapabilitiesSection connect native transport", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("forwards the POST /api/capability-router/connect deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ success: true, mode: "endpoint" }),
    );
    await expect(
      fetchCapabilityRouterConnect(
        { persist: true, unloadMissing: false },
        CAPABILITY_ROUTER_CONNECT_FETCH_TIMEOUT_MS,
        makeClient(request),
      ),
    ).resolves.toEqual({ success: true, mode: "endpoint" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/capability-router/connect",
      expect.objectContaining({ method: "POST" }),
      { timeoutMs: CAPABILITY_ROUTER_CONNECT_FETCH_TIMEOUT_MS },
    );
  });

  it("times out a stalled connect hop through ElizaClient", async () => {
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
      fetchCapabilityRouterConnect({ persist: true }, 10, makeClient(request)),
    ).rejects.toMatchObject({ name: "ApiError", kind: "timeout" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/capability-router/connect",
      expect.objectContaining({ method: "POST" }),
      { timeoutMs: 10 },
    );
  });

  it("surfaces a provider error from the connect hop", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () => {
      throw Object.assign(new Error("capability router unavailable"), {
        name: "TypeError",
      });
    });
    await expect(
      fetchCapabilityRouterConnect(
        { persist: true },
        10_000,
        makeClient(request),
      ),
    ).rejects.toMatchObject({ name: "ApiError" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/capability-router/connect",
      expect.objectContaining({ method: "POST" }),
      { timeoutMs: 10_000 },
    );
  });
});
