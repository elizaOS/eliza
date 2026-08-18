/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves the startup cloud-passthrough GET /api/status hop carries timeoutMs
 * into Agent.request. listConversations and remaining startup hops stay
 * untouched. Not packages/cloud JSON. Not browser-launch.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "../api/client-base";
import type { AgentRequestTransport } from "../api/transport";
import { setBootConfig } from "../config/boot-config";
import {
  fetchCloudProxyAgentStatus,
  STARTUP_CLOUD_PROXY_STATUS_FETCH_TIMEOUT_MS,
} from "./startup-phase-runtime";

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

describe("startup-phase-runtime cloud-proxy status native transport", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("forwards the GET /api/status deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ state: "running", canRespond: true }),
    );
    await expect(
      fetchCloudProxyAgentStatus(
        STARTUP_CLOUD_PROXY_STATUS_FETCH_TIMEOUT_MS,
        makeClient(request),
      ),
    ).resolves.toEqual({ state: "running", canRespond: true });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/status",
      expect.any(Object),
      { timeoutMs: STARTUP_CLOUD_PROXY_STATUS_FETCH_TIMEOUT_MS },
    );
  });

  it("times out a stalled status hop through ElizaClient", async () => {
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
      fetchCloudProxyAgentStatus(10, makeClient(request)),
    ).rejects.toMatchObject({ name: "ApiError", kind: "timeout" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/status",
      expect.any(Object),
      { timeoutMs: 10 },
    );
  });

  it("surfaces a provider error from the status hop", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () => {
      throw Object.assign(new Error("status passthrough unavailable"), {
        name: "TypeError",
      });
    });
    await expect(
      fetchCloudProxyAgentStatus(10_000, makeClient(request)),
    ).rejects.toMatchObject({ name: "ApiError" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/status",
      expect.any(Object),
      { timeoutMs: 10_000 },
    );
  });
});
