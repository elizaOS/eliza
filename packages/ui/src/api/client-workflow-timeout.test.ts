/** Verifies workflow status / list hops pass timeoutMs through ElizaClient.fetch. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import {
  WORKFLOW_LIST_FETCH_TIMEOUT_MS,
  WORKFLOW_STATUS_FETCH_TIMEOUT_MS,
} from "./client-workflow";
import "./client-workflow";
import type { AgentRequestTransport } from "./transport";
import { setBootConfig } from "../config/boot-config";

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

const status = {
  mode: "disabled",
  host: null,
  status: "ready",
  cloudConnected: false,
  localEnabled: true,
  engine: "smthrs",
};

describe("ElizaClient workflow native-complete deadlines", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("keeps a documented budget per hop", () => {
    expect(WORKFLOW_STATUS_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(WORKFLOW_LIST_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("passes status timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json(status),
    );
    await makeClient(request).getWorkflowStatus();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/workflow/status",
      expect.any(Object),
      { timeoutMs: WORKFLOW_STATUS_FETCH_TIMEOUT_MS },
    );
  });

  it("passes list timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ workflows: [] }),
    );
    await makeClient(request).listWorkflowDefinitions();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/workflow/workflows",
      expect.any(Object),
      { timeoutMs: WORKFLOW_LIST_FETCH_TIMEOUT_MS },
    );
  });

  it("aborts a stalled status hop as TimeoutError", async () => {
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
    await expect(makeClient(request).getWorkflowStatus(10)).rejects.toMatchObject(
      {
        name: "ApiError",
        kind: "timeout",
      },
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
    await expect(
      makeClient(request).listWorkflowDefinitions(),
    ).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
    });
  });
});
