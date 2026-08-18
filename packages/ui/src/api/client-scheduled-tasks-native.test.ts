/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves listScheduledTasks carries timeoutMs into Agent.request.
 * Query construction (#21541) is unchanged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import { SCHEDULED_TASKS_LIST_FETCH_TIMEOUT_MS } from "./client-scheduled-tasks";
import "./client-scheduled-tasks";
import type { AgentRequestTransport } from "./transport";
import { setBootConfig } from "../config/boot-config";

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

describe("ElizaClient scheduled-tasks native-complete deadlines", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("keeps a documented budget for the list hop", () => {
    expect(SCHEDULED_TASKS_LIST_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("forwards the list deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ tasks: [] }),
    );
    await makeClient(request).listScheduledTasks();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/lifeops/scheduled-tasks",
      expect.any(Object),
      { timeoutMs: SCHEDULED_TASKS_LIST_FETCH_TIMEOUT_MS },
    );
  });

  it("keeps ownerVisibleOnly query construction unchanged", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ tasks: [] }),
    );
    await makeClient(request).listScheduledTasks({ ownerVisibleOnly: true });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/lifeops/scheduled-tasks?ownerVisibleOnly=1",
      expect.any(Object),
      { timeoutMs: SCHEDULED_TASKS_LIST_FETCH_TIMEOUT_MS },
    );
  });

  it("times out a stalled list hop through ElizaClient", async () => {
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
      makeClient(request).listScheduledTasks(undefined, 10),
    ).rejects.toMatchObject({
      name: "ApiError",
      kind: "timeout",
    });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/lifeops/scheduled-tasks",
      expect.any(Object),
      { timeoutMs: 10 },
    );
  });

  it("surfaces a provider error from a completed list GET", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(
      async () =>
        new Response(JSON.stringify({ error: "unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(makeClient(request).listScheduledTasks()).rejects.toMatchObject(
      {
        name: "ApiError",
        status: 503,
      },
    );
  });
});
