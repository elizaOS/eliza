/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves browser-bridge hops carry timeoutMs into Agent.request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "../../api/client-base";
import type { AgentRequestTransport } from "../../api/transport";
import { setBootConfig } from "../../config/boot-config";
import {
  BROWSER_BRIDGE_OPEN_MANAGER_FETCH_TIMEOUT_MS,
  BROWSER_BRIDGE_PACKAGES_FETCH_TIMEOUT_MS,
  fetchBrowserBridgePackages,
  openBrowserBridgeChromeManager,
} from "./BrowserWorkspaceView";

function makeClientWithTransport(request: AgentRequestTransport["request"]) {
  const api = new ElizaClient("http://agent.example:2138", "token");
  api.setRequestTransport({ request });
  return api;
}

describe("BrowserWorkspaceView ElizaClient native transport", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("forwards the packages deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ status: {} }),
    );
    const api = makeClientWithTransport(request);
    await fetchBrowserBridgePackages(api);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/browser-bridge/packages",
      expect.any(Object),
      { timeoutMs: BROWSER_BRIDGE_PACKAGES_FETCH_TIMEOUT_MS },
    );
  });

  it("forwards the open-manager deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ ok: true }),
    );
    const api = makeClientWithTransport(request);
    await openBrowserBridgeChromeManager(api);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/browser-bridge/packages/chrome/open-manager",
      expect.any(Object),
      { timeoutMs: BROWSER_BRIDGE_OPEN_MANAGER_FETCH_TIMEOUT_MS },
    );
  });

  it("times out a stalled open-manager hop through ElizaClient", async () => {
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
    const api = makeClientWithTransport(request);
    await expect(
      openBrowserBridgeChromeManager(api, 10),
    ).rejects.toMatchObject({ name: "ApiError", kind: "timeout" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/browser-bridge/packages/chrome/open-manager",
      expect.any(Object),
      { timeoutMs: 10 },
    );
  });
});
