/**
 * Exercises Google OAuth deadlines and caller cancellation through injectable
 * token-exchange and userinfo HTTP boundaries.
 */
import { describe, expect, it } from "vitest";
import {
  exchangeAuthorizationCodeWithFetch,
  fetchGoogleUserInfoWithFetch,
} from "./connector-account-provider.js";

const TOKEN_ARGS = {
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "http://127.0.0.1:31437/api/connectors/google/oauth/callback",
  code: "oauth-code",
};

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected oauth abort signal");
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) as typeof fetch;
}

describe("Google OAuth request deadlines", () => {
  it("aborts a stalled token exchange at the injected deadline", async () => {
    await expect(
      exchangeAuthorizationCodeWithFetch(TOKEN_ARGS, stallUntilAborted(), 10)
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed token exchange", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("invalid_grant", { status: 400, statusText: "Bad Request" });

    await expect(exchangeAuthorizationCodeWithFetch(TOKEN_ARGS, fetchImpl, 1_000)).rejects.toThrow(
      "invalid_grant"
    );
  });

  it("preserves caller cancellation during token exchange", async () => {
    const controller = new AbortController();
    const reason = new DOMException("oauth flow stopped", "AbortError");
    const pending = exchangeAuthorizationCodeWithFetch(
      TOKEN_ARGS,
      stallUntilAborted(),
      1_000,
      controller.signal
    );

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it("uses the injected fetch for a successful token exchange", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return Response.json({ access_token: "tok", expires_in: 3600, token_type: "Bearer" });
    };

    const tokens = await exchangeAuthorizationCodeWithFetch(TOKEN_ARGS, fetchImpl, 1_000);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(tokens.access_token).toBe("tok");
    expect(tokens.expires_in).toBe(3600);
  });

  it("aborts a stalled userinfo request at the injected deadline", async () => {
    await expect(
      fetchGoogleUserInfoWithFetch("access-token", stallUntilAborted(), 10)
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed userinfo request", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("", { status: 429, statusText: "Too Many Requests" });

    await expect(fetchGoogleUserInfoWithFetch("access-token", fetchImpl, 1_000)).rejects.toThrow(
      "429"
    );
  });

  it("uses the injected fetch for a successful userinfo request", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return Response.json({ email: "ada@example.com", sub: "google-subject" });
    };

    const identity = await fetchGoogleUserInfoWithFetch("access-token", fetchImpl, 1_000);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(identity.email).toBe("ada@example.com");
    expect(identity.sub).toBe("google-subject");
  });
});
