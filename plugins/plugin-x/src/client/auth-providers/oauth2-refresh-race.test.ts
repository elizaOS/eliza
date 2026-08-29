/**
 * Regression coverage for the OAuth 2.0 PKCE single-use refresh-token race.
 * plugin-x runs several independent loops (post, interactions, discovery) that
 * share one `OAuth2PKCEAuthProvider` instance. When the user-context token
 * expires, multiple loops can observe the expiry window and each call
 * `refreshAccessToken` with the same rotating (single-use) refresh token, so
 * X returns HTTP 400 `invalid_grant` to the losing caller. These tests drive
 * the real provider against a deterministic single-use-refresh `fetchImpl` and
 * an in-memory `TokenStore`; no live X credentials are required.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { OAuth2PKCEAuthProvider } from "./oauth2-pkce";
import type { StoredOAuth2Tokens, TokenStore } from "./token-store";

function createRuntime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    getSetting: vi.fn(
      (key: string) =>
        ({
          TWITTER_CLIENT_ID: "client-id",
          TWITTER_REDIRECT_URI: "http://127.0.0.1/callback",
        })[key],
    ),
  } as unknown as IAgentRuntime;
}

function createStore(initial: StoredOAuth2Tokens | null): TokenStore {
  let current = initial;
  return {
    load: vi.fn(async () => current),
    save: vi.fn(async (t: StoredOAuth2Tokens) => {
      current = t;
    }),
    clear: vi.fn(async () => {
      current = null;
    }),
  };
}

/**
 * Models X's rotating, single-use refresh tokens: the first refresh of a token
 * rotates it and returns a fresh access/refresh pair; any later use of an
 * already-spent refresh token returns HTTP 400 `invalid_grant`.
 */
function singleUseRefreshFetch(opts?: { alwaysInvalid?: boolean }) {
  const spent = new Set<string>();
  const refreshCalls: string[] = [];
  let counter = 0;
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    const params = new URLSearchParams(String(init?.body ?? ""));
    const rt = params.get("refresh_token") ?? "";
    refreshCalls.push(rt);
    if (opts?.alwaysInvalid || spent.has(rt)) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
      });
    }
    spent.add(rt);
    counter += 1;
    return new Response(
      JSON.stringify({
        access_token: `A${counter}`,
        refresh_token: `R${counter}`,
        expires_in: 7200,
        token_type: "bearer",
      }),
      { status: 200 },
    );
  });
  return { fetchImpl, refreshCalls };
}

function expiredTokens(): StoredOAuth2Tokens {
  return {
    access_token: "A0",
    refresh_token: "R0",
    expires_at: Date.now() - 1000,
  };
}

describe("OAuth2PKCEAuthProvider concurrent refresh", () => {
  it("collapses concurrent expiry-window callers onto a single refresh", async () => {
    const { fetchImpl, refreshCalls } = singleUseRefreshFetch();
    const store = createStore(expiredTokens());
    const provider = new OAuth2PKCEAuthProvider(
      createRuntime(),
      undefined,
      store,
      fetchImpl as unknown as typeof fetch,
    );

    const results = await Promise.allSettled([
      provider.getAccessToken(),
      provider.getAccessToken(),
      provider.getAccessToken(),
    ]);

    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(0);

    // Exactly one network refresh happened, spending only the original R0.
    expect(refreshCalls).toEqual(["R0"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // All callers share the single rotated access token.
    const tokens = results.map((r) =>
      r.status === "fulfilled" ? r.value : null,
    );
    expect(new Set(tokens)).toEqual(new Set(["A1"]));

    // The store persisted the rotated credential exactly once.
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(store.save).toHaveBeenCalledWith(
      expect.objectContaining({ access_token: "A1", refresh_token: "R1" }),
    );
  });

  it("reuses the cached rotated token after the shared refresh without another fetch", async () => {
    const { fetchImpl, refreshCalls } = singleUseRefreshFetch();
    const provider = new OAuth2PKCEAuthProvider(
      createRuntime(),
      undefined,
      createStore(expiredTokens()),
      fetchImpl as unknown as typeof fetch,
    );

    await Promise.all([provider.getAccessToken(), provider.getAccessToken()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // A later call within the fresh token's validity window hits the cache.
    const third = await provider.getAccessToken();
    expect(third).toBe("A1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(refreshCalls).toEqual(["R0"]);
  });

  it("surfaces a genuine invalid_grant from the single in-flight refresh to every awaiter", async () => {
    const { fetchImpl, refreshCalls } = singleUseRefreshFetch({
      alwaysInvalid: true,
    });
    const provider = new OAuth2PKCEAuthProvider(
      createRuntime(),
      undefined,
      createStore(expiredTokens()),
      fetchImpl as unknown as typeof fetch,
    );

    const results = await Promise.allSettled([
      provider.getAccessToken(),
      provider.getAccessToken(),
    ]);

    expect(results.every((r) => r.status === "rejected")).toBe(true);
    for (const r of results) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(Error);
      expect((r as PromiseRejectedResult).reason.message).toContain(
        "invalid_grant",
      );
    }
    // Only one refresh was attempted even though both callers failed.
    expect(refreshCalls).toEqual(["R0"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent interactive logins when no tokens exist", async () => {
    let logins = 0;
    const interactiveLoginFn = vi.fn(async () => {
      logins += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        access_token: `login-${logins}`,
        refresh_token: `login-refresh-${logins}`,
        expires_at: Date.now() + 7200 * 1000,
      } satisfies StoredOAuth2Tokens;
    });
    const store = createStore(null);
    const provider = new OAuth2PKCEAuthProvider(
      createRuntime(),
      undefined,
      store,
      vi.fn() as unknown as typeof fetch,
      interactiveLoginFn,
    );

    const [a, b] = await Promise.all([
      provider.getAccessToken(),
      provider.getAccessToken(),
    ]);

    // A single interactive login serves both callers.
    expect(interactiveLoginFn).toHaveBeenCalledTimes(1);
    expect(a).toBe("login-1");
    expect(b).toBe("login-1");
    expect(store.save).toHaveBeenCalledTimes(1);
  });
});
