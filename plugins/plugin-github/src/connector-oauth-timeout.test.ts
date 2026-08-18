/**
 * Exercises GitHub OAuth transport deadlines through the registered connector
 * provider with deterministic fetch and abort signals; no live GitHub calls.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubConnectorAccountProvider } from "./connector-account-provider.js";

const runtime = Object.assign(Object.create(null) as IAgentRuntime, {
  getSetting: (key: string) =>
    ({
      GITHUB_OAUTH_CLIENT_ID: "github-client",
      GITHUB_OAUTH_CLIENT_SECRET: "github-secret",
      GITHUB_OAUTH_REDIRECT_URI: "http://localhost/oauth/github/callback",
    })[key] ?? null,
});

const callback = {
  provider: "github",
  code: "oauth-code",
  query: {},
  flow: {
    id: "flow-1",
    provider: "github",
    state: "state-1",
    status: "pending" as const,
    codeVerifier: "pkce-verifier",
    createdAt: 1,
    updatedAt: 1,
    metadata: {},
  },
};

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected GitHub OAuth abort signal");
      const onAbort = () => reject(signal.reason);
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    })) as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GitHub OAuth request deadlines", () => {
  it("aborts a stalled token exchange at the connector deadline", async () => {
    const controller = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);
    vi.stubGlobal("fetch", stallUntilAborted());

    const pending = createGitHubConnectorAccountProvider(
      runtime,
    ).completeOAuth?.(callback, {} as never);
    controller.abort(new DOMException("deadline", "TimeoutError"));

    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    expect(timeout).toHaveBeenCalledWith(15_000);
  });

  it("aborts stalled userinfo after a completed token exchange", async () => {
    const tokenController = new AbortController();
    const userController = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValueOnce(tokenController.signal)
      .mockReturnValueOnce(userController.signal);
    const stalled = stallUntilAborted();
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes("access_token")) {
          return Response.json({ access_token: "tok", token_type: "bearer" });
        }
        return stalled(input, init);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = createGitHubConnectorAccountProvider(
      runtime,
    ).completeOAuth?.(callback, {} as never);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    userController.abort(new DOMException("deadline", "TimeoutError"));

    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    expect(timeout).toHaveBeenNthCalledWith(1, 15_000);
    expect(timeout).toHaveBeenNthCalledWith(2, 15_000);
  });

  it("preserves completed provider error contracts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("bad_verification_code", {
            status: 400,
            statusText: "Bad Request",
          }),
      ),
    );

    await expect(
      createGitHubConnectorAccountProvider(runtime).completeOAuth?.(
        callback,
        {} as never,
      ),
    ).rejects.toThrow("GitHub token exchange failed with 400");
  });
});
