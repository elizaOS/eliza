/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves the GitHub token status hop carries timeoutMs into Agent.request.
 * Device poll/start, POST token, and DELETE stay untouched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "../../../packages/ui/src/api/client-base";
import type { AgentRequestTransport } from "../../../packages/ui/src/api/transport";
import { setBootConfig } from "../../../packages/ui/src/config/boot-config";
import {
  fetchGitHubTokenStatus,
  GITHUB_TOKEN_STATUS_FETCH_TIMEOUT_MS,
} from "./GitHubConnectionCard";

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

describe("GitHubConnectionCard token-status native transport", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("forwards the GET /api/github/token deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ connected: false, deviceFlowAvailable: false }),
    );
    await expect(
      fetchGitHubTokenStatus(
        GITHUB_TOKEN_STATUS_FETCH_TIMEOUT_MS,
        makeClient(request),
      ),
    ).resolves.toEqual({ connected: false, deviceFlowAvailable: false });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/github/token",
      expect.any(Object),
      { timeoutMs: GITHUB_TOKEN_STATUS_FETCH_TIMEOUT_MS },
    );
  });

  it("times out a stalled token-status hop through ElizaClient", async () => {
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
      fetchGitHubTokenStatus(10, makeClient(request)),
    ).rejects.toMatchObject({ name: "ApiError", kind: "timeout" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/github/token",
      expect.any(Object),
      { timeoutMs: 10 },
    );
  });

  it("surfaces a provider error from the token-status hop", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () => {
      throw Object.assign(new Error("github token status unavailable"), {
        name: "TypeError",
      });
    });
    await expect(
      fetchGitHubTokenStatus(10_000, makeClient(request)),
    ).rejects.toMatchObject({ name: "ApiError" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/github/token",
      expect.any(Object),
      { timeoutMs: 10_000 },
    );
  });
});
