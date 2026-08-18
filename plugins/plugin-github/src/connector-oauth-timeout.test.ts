/**
 * Behavioral GitHub OAuth deadlines. Executes token-exchange and userinfo
 * under abort — not a source-grep of connector-account-provider.ts.
 */
import { describe, expect, it } from "vitest";
import {
  GITHUB_OAUTH_TIMEOUT_MS,
  exchangeCodeForTokenWithFetch,
  fetchGitHubUserWithFetch,
} from "./connector-account-provider.js";

const TOKEN_ARGS = {
  clientId: "github-client",
  clientSecret: "github-secret",
  redirectUri: "http://localhost/oauth/github/callback",
  code: "oauth-code",
};

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected github oauth abort signal");
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as typeof fetch;
}

describe("GitHub OAuth request deadlines", () => {
  it("keeps a documented OAuth budget", () => {
    expect(GITHUB_OAUTH_TIMEOUT_MS).toBe(15_000);
  });

  it("aborts a stalled token exchange at the injected deadline", async () => {
    await expect(
      exchangeCodeForTokenWithFetch(TOKEN_ARGS, stallUntilAborted(), 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed token exchange", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("bad_verification_code", {
        status: 400,
        statusText: "Bad Request",
      });

    await expect(
      exchangeCodeForTokenWithFetch(TOKEN_ARGS, fetchImpl, 1_000),
    ).rejects.toThrow("400");
  });

  it("uses the injected fetch for a successful token exchange", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return Response.json({
        access_token: "tok",
        token_type: "bearer",
        scope: "repo",
      });
    };

    const tokens = await exchangeCodeForTokenWithFetch(
      TOKEN_ARGS,
      fetchImpl,
      1_000,
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(tokens.access_token).toBe("tok");
    expect(tokens.scope).toBe("repo");
  });

  it("aborts a stalled userinfo request at the injected deadline", async () => {
    await expect(
      fetchGitHubUserWithFetch("access-token", stallUntilAborted(), 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed userinfo request", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("", { status: 401, statusText: "Unauthorized" });

    await expect(
      fetchGitHubUserWithFetch("access-token", fetchImpl, 1_000),
    ).rejects.toThrow("401");
  });

  it("uses the injected fetch for a successful userinfo request", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return Response.json({
        login: "ada",
        id: 123,
        name: "Ada",
      });
    };

    const user = await fetchGitHubUserWithFetch("access-token", fetchImpl, 1_000);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(user.login).toBe("ada");
    expect(user.id).toBe(123);
  });
});
