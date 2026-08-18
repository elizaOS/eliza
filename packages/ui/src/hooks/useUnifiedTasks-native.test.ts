/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves unified-task hops carry timeoutMs into Agent.request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "../api/client-base";
import type { AgentRequestTransport } from "../api/transport";
import { setBootConfig } from "../config/boot-config";
import {
  fetchUnifiedAutomations,
  fetchUnifiedScheduledTasks,
  UNIFIED_AUTOMATIONS_FETCH_TIMEOUT_MS,
  UNIFIED_SCHEDULED_TASKS_FETCH_TIMEOUT_MS,
} from "./useUnifiedTasks";

function makeClientWithTransport(request: AgentRequestTransport["request"]) {
  const api = new ElizaClient("http://agent.example:2138", "token");
  api.setRequestTransport({ request });
  return api;
}

describe("useUnifiedTasks ElizaClient native transport", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("forwards the automations deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({
        automations: [],
        summary: {
          total: 0,
          coordinatorCount: 0,
          workflowCount: 0,
          scheduledCount: 0,
          draftCount: 0,
        },
        workflowStatus: null,
        workflowFetchError: null,
        executionFetchErrors: [],
      }),
    );
    const api = makeClientWithTransport(request);
    await fetchUnifiedAutomations(api);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/automations",
      expect.any(Object),
      { timeoutMs: UNIFIED_AUTOMATIONS_FETCH_TIMEOUT_MS },
    );
  });

  it("forwards the scheduled-tasks deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ tasks: [] }),
    );
    const api = makeClientWithTransport(request);
    await fetchUnifiedScheduledTasks(api, true);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/lifeops/scheduled-tasks?ownerVisibleOnly=1",
      expect.any(Object),
      { timeoutMs: UNIFIED_SCHEDULED_TASKS_FETCH_TIMEOUT_MS },
    );
  });

  it("times out a stalled automations hop through ElizaClient", async () => {
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
    await expect(fetchUnifiedAutomations(api, 10)).rejects.toMatchObject({
      name: "ApiError",
      kind: "timeout",
    });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/automations",
      expect.any(Object),
      { timeoutMs: 10 },
    );
  });
});
