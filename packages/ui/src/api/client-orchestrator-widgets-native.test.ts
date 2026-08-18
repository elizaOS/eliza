/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves getOrchestratorWidgets carries timeoutMs into Agent.request.
 * widgetQuery / #21541 list-limit construction is unchanged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import { ORCHESTRATOR_WIDGETS_FETCH_TIMEOUT_MS } from "./client-orchestrator-widgets";
import "./client-orchestrator-widgets";
import type { AgentRequestTransport } from "./transport";
import { setBootConfig } from "../config/boot-config";

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

const snapshot = {
  version: "orchestrator.widgets.v1" as const,
  generatedAt: "2026-08-18T00:00:00.000Z",
  totalTaskCount: 0,
  tasks: [],
};

describe("ElizaClient orchestrator-widgets native-complete deadlines", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("keeps a documented budget for the widgets hop", () => {
    expect(ORCHESTRATOR_WIDGETS_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("forwards the widgets deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json(snapshot),
    );
    await makeClient(request).getOrchestratorWidgets();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/orchestrator/widgets",
      expect.any(Object),
      { timeoutMs: ORCHESTRATOR_WIDGETS_FETCH_TIMEOUT_MS },
    );
  });

  it("keeps limit query construction unchanged", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json(snapshot),
    );
    await makeClient(request).getOrchestratorWidgets({ limit: 8 });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/orchestrator/widgets?limit=8",
      expect.any(Object),
      { timeoutMs: ORCHESTRATOR_WIDGETS_FETCH_TIMEOUT_MS },
    );
  });

  it("times out a stalled widgets hop through ElizaClient", async () => {
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
      makeClient(request).getOrchestratorWidgets(undefined, 10),
    ).rejects.toMatchObject({
      name: "ApiError",
      kind: "timeout",
    });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/orchestrator/widgets",
      expect.any(Object),
      { timeoutMs: 10 },
    );
  });

  it("surfaces a provider error from a completed widgets GET", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(
      async () =>
        new Response(JSON.stringify({ error: "unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(
      makeClient(request).getOrchestratorWidgets(),
    ).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
    });
  });
});
