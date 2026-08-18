/** Verifies computer-use hops pass timeoutMs through ElizaClient.fetch. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import {
  COMPUTER_USE_GET_APPROVALS_FETCH_TIMEOUT_MS,
  COMPUTER_USE_RESPOND_FETCH_TIMEOUT_MS,
  COMPUTER_USE_SET_MODE_FETCH_TIMEOUT_MS,
} from "./client-computeruse";
import "./client-computeruse";
import type { AgentRequestTransport } from "./transport";
import { setBootConfig } from "../config/boot-config";

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

describe("ElizaClient computer-use native-complete deadlines", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("keeps a documented budget per hop", () => {
    expect(COMPUTER_USE_GET_APPROVALS_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(COMPUTER_USE_RESPOND_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(COMPUTER_USE_SET_MODE_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("passes get-approvals timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ mode: "off", pendingCount: 0, pendingApprovals: [] }),
    );
    await makeClient(request).getComputerUseApprovals();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/computer-use/approvals",
      expect.any(Object),
      { timeoutMs: COMPUTER_USE_GET_APPROVALS_FETCH_TIMEOUT_MS },
    );
  });

  it("passes respond timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({
        id: "a1",
        command: "open",
        approved: true,
        cancelled: false,
        mode: "smart_approve",
        requestedAt: "now",
        resolvedAt: "now",
      }),
    );
    await makeClient(request).respondToComputerUseApproval("a1", true);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/computer-use/approvals/a1",
      expect.any(Object),
      { timeoutMs: COMPUTER_USE_RESPOND_FETCH_TIMEOUT_MS },
    );
  });

  it("passes set-mode timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ mode: "off" }),
    );
    await makeClient(request).setComputerUseApprovalMode("off");
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/computer-use/approval-mode",
      expect.any(Object),
      { timeoutMs: COMPUTER_USE_SET_MODE_FETCH_TIMEOUT_MS },
    );
  });

  it("aborts a stalled respond hop as TimeoutError", async () => {
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
      makeClient(request).respondToComputerUseApproval(
        "a1",
        true,
        undefined,
        10,
      ),
    ).rejects.toMatchObject({ name: "ApiError", kind: "timeout" });
  });

  it("surfaces a provider error from a completed get-approvals GET", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(
      async () =>
        new Response(JSON.stringify({ error: "unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(
      makeClient(request).getComputerUseApprovals(),
    ).rejects.toMatchObject({ name: "ApiError", status: 503 });
  });
});
