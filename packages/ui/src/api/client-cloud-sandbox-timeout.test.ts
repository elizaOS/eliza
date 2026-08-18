/** Verifies sandbox platform / browser hops pass timeoutMs through ElizaClient.fetch. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import {
  SANDBOX_BROWSER_FETCH_TIMEOUT_MS,
  SANDBOX_PLATFORM_FETCH_TIMEOUT_MS,
} from "./client-cloud";
import "./client-cloud";
import type { AgentRequestTransport } from "./transport";
import { setBootConfig } from "../config/boot-config";

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

const platform = {
  platform: "darwin",
  arch: "arm64",
  dockerInstalled: true,
  dockerAvailable: true,
  dockerRunning: true,
  recommended: "docker",
};

const browser = {
  cdpEndpoint: "http://127.0.0.1:9222",
  wsEndpoint: null,
  noVncEndpoint: null,
};

describe("ElizaClient sandbox native-complete deadlines", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("keeps a documented budget per hop", () => {
    expect(SANDBOX_PLATFORM_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(SANDBOX_BROWSER_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("passes platform timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json(platform),
    );
    await makeClient(request).getSandboxPlatform();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/sandbox/platform",
      expect.any(Object),
      { timeoutMs: SANDBOX_PLATFORM_FETCH_TIMEOUT_MS },
    );
  });

  it("passes browser timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json(browser),
    );
    await makeClient(request).getSandboxBrowser();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/sandbox/browser",
      expect.any(Object),
      { timeoutMs: SANDBOX_BROWSER_FETCH_TIMEOUT_MS },
    );
  });

  it("aborts a stalled platform hop as TimeoutError", async () => {
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
      makeClient(request).getSandboxPlatform(10),
    ).rejects.toMatchObject({
      name: "ApiError",
      kind: "timeout",
    });
  });

  it("surfaces a provider error from a completed browser GET", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(
      async () =>
        new Response(JSON.stringify({ error: "unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(makeClient(request).getSandboxBrowser()).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
    });
  });
});
