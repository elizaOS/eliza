/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves getLifeOpsOverview carries timeoutMs into Agent.request.
 * Lives here because plugin-personal-assistant vitest stubs @elizaos/ui;
 * this config aliases the real client-base (same as getLifeOpsCalendarFeed).
 * Money hops stay off. Remaining lifeops hops stay untouched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "@elizaos/ui/api/client-base";
import type { AgentRequestTransport } from "@elizaos/ui/api/transport";
import { setBootConfig } from "@elizaos/ui/config/boot-config";
import { LIFEOPS_OVERVIEW_FETCH_TIMEOUT_MS } from "../../../plugin-personal-assistant/src/api/client-lifeops";
import "../../../plugin-personal-assistant/src/api/client-lifeops";

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

describe("getLifeOpsOverview native transport", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("forwards the overview deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ ok: true }),
    );
    await makeClient(request).getLifeOpsOverview();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/lifeops/overview",
      expect.any(Object),
      { timeoutMs: LIFEOPS_OVERVIEW_FETCH_TIMEOUT_MS },
    );
  });

  it("times out a stalled overview hop through ElizaClient", async () => {
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
      makeClient(request).getLifeOpsOverview(10),
    ).rejects.toMatchObject({ name: "ApiError", kind: "timeout" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/lifeops/overview",
      expect.any(Object),
      { timeoutMs: 10 },
    );
  });

  it("surfaces a provider error from the overview hop", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () => {
      throw Object.assign(new Error("lifeops overview unavailable"), {
        name: "TypeError",
      });
    });
    await expect(
      makeClient(request).getLifeOpsOverview(),
    ).rejects.toMatchObject({ name: "ApiError" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/lifeops/overview",
      expect.any(Object),
      { timeoutMs: LIFEOPS_OVERVIEW_FETCH_TIMEOUT_MS },
    );
  });
});
