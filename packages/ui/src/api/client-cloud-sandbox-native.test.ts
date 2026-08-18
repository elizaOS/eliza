/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves sandbox platform and browser hops carry timeoutMs into Agent.request.
 */
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

describe("ElizaClient sandbox native transport", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("forwards the platform deadline to Agent.request", async () => {
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

  it("forwards the browser deadline to Agent.request", async () => {
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

  it("times out a stalled browser hop through ElizaClient", async () => {
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
    await expect(makeClient(request).getSandboxBrowser(10)).rejects.toMatchObject(
      {
        name: "ApiError",
        kind: "timeout",
      },
    );
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/sandbox/browser",
      expect.any(Object),
      { timeoutMs: 10 },
    );
  });
});
