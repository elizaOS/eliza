/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves AppsSection kebab hops carry timeoutMs into Agent.request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "../../api/client-base";
import type { AgentRequestTransport } from "../../api/transport";
import { setBootConfig } from "../../config/boot-config";
import {
  APPS_CREATE_EDIT_FETCH_TIMEOUT_MS,
  APPS_RELAUNCH_FETCH_TIMEOUT_MS,
  relaunchAppViaClient,
  startAppEditViaClient,
} from "./AppsSection";

function makeClientWithTransport(request: AgentRequestTransport["request"]) {
  const api = new ElizaClient("http://agent.example:2138", "token");
  api.setRequestTransport({ request });
  return api;
}

describe("AppsSection ElizaClient native transport", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("forwards the relaunch deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ ok: true }),
    );
    const api = makeClientWithTransport(request);
    await relaunchAppViaClient(api, "demo");
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/apps/relaunch",
      expect.any(Object),
      { timeoutMs: APPS_RELAUNCH_FETCH_TIMEOUT_MS },
    );
  });

  it("forwards the create/edit deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ ok: true }),
    );
    const api = makeClientWithTransport(request);
    await startAppEditViaClient(api, "demo");
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/apps/create",
      expect.any(Object),
      { timeoutMs: APPS_CREATE_EDIT_FETCH_TIMEOUT_MS },
    );
  });

  it("times out a stalled relaunch hop through ElizaClient", async () => {
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
    await expect(relaunchAppViaClient(api, "demo", 10)).rejects.toMatchObject({
      name: "ApiError",
      kind: "timeout",
    });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/apps/relaunch",
      expect.any(Object),
      { timeoutMs: 10 },
    );
  });
});
