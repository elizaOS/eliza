/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves the Apps Management relaunch hop carries timeoutMs into Agent.request.
 * Create / load-from-directory stay untouched. Not AppsSection (#21965).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "../../api/client-base";
import type { AgentRequestTransport } from "../../api/transport";
import { setBootConfig } from "../../config/boot-config";
import {
  APPS_MANAGEMENT_RELAUNCH_FETCH_TIMEOUT_MS,
  fetchAppsManagementRelaunch,
} from "./AppsManagementSection";

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

describe("AppsManagementSection relaunch native transport", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("forwards the POST /api/apps/relaunch deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ ok: true, message: "relaunching" }),
    );
    await expect(
      fetchAppsManagementRelaunch(
        { name: "demo", verify: true },
        APPS_MANAGEMENT_RELAUNCH_FETCH_TIMEOUT_MS,
        makeClient(request),
      ),
    ).resolves.toEqual({ ok: true, message: "relaunching" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/apps/relaunch",
      expect.objectContaining({ method: "POST" }),
      { timeoutMs: APPS_MANAGEMENT_RELAUNCH_FETCH_TIMEOUT_MS },
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
    await expect(
      fetchAppsManagementRelaunch(
        { name: "demo", verify: false },
        10,
        makeClient(request),
      ),
    ).rejects.toMatchObject({ name: "ApiError", kind: "timeout" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/apps/relaunch",
      expect.objectContaining({ method: "POST" }),
      { timeoutMs: 10 },
    );
  });

  it("surfaces a provider error from the relaunch hop", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () => {
      throw Object.assign(new Error("apps relaunch unavailable"), {
        name: "TypeError",
      });
    });
    await expect(
      fetchAppsManagementRelaunch(
        { name: "demo", verify: true },
        10_000,
        makeClient(request),
      ),
    ).rejects.toMatchObject({ name: "ApiError" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/apps/relaunch",
      expect.objectContaining({ method: "POST" }),
      { timeoutMs: 10_000 },
    );
  });
});
