/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves computer-use hops carry timeoutMs into Agent.request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import {
  COMPUTER_USE_GET_APPROVALS_FETCH_TIMEOUT_MS,
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

describe("ElizaClient computer-use native transport", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("forwards the get-approvals deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ mode: "off", pendingCount: 0 }),
    );
    await makeClient(request).getComputerUseApprovals();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/computer-use/approvals",
      expect.any(Object),
      { timeoutMs: COMPUTER_USE_GET_APPROVALS_FETCH_TIMEOUT_MS },
    );
  });

  it("forwards the set-mode deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ mode: "smart_approve" }),
    );
    await makeClient(request).setComputerUseApprovalMode("smart_approve");
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/computer-use/approval-mode",
      expect.any(Object),
      { timeoutMs: COMPUTER_USE_SET_MODE_FETCH_TIMEOUT_MS },
    );
  });

  it("times out a stalled get-approvals hop through ElizaClient", async () => {
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
      makeClient(request).getComputerUseApprovals(10),
    ).rejects.toMatchObject({ name: "ApiError", kind: "timeout" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/computer-use/approvals",
      expect.any(Object),
      { timeoutMs: 10 },
    );
  });
});
