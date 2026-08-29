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
function singleUseRefreshFetch(opts?: {
  alwaysInvalid?: boolean;
  expiresIn?: number;
}) {
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
        expires_in: opts?.expiresIn ?? 7200,
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

  it("does not let a store read that spans the winner's save re-spend the old refresh token", async () => {
    // Models a token store backed by real I/O: a read captures its snapshot at
    // read-start time and can resolve *after* a concurrent save. Caller B's read
    // starts first and blocks; caller A loads immediately, refreshes R0 -> R1 and
    // saves; only then does B's read resolve with the pre-write R0 snapshot.
    let current: StoredOAuth2Tokens | null = expiredTokens();
    let loadCount = 0;
    let releaseSecondLoad: () => void = () => {};
    const secondLoadGate = new Promise<void>((resolve) => {
      releaseSecondLoad = resolve;
    });
    const store: TokenStore = {
      load: vi.fn(async () => {
        loadCount += 1;
        const snapshot = current; // captured at read start, like a DB read tx
        if (loadCount === 2) await secondLoadGate;
        return snapshot;
      }),
      save: vi.fn(async (t: StoredOAuth2Tokens) => {
        current = t;
      }),
      clear: vi.fn(async () => {
        current = null;
      }),
    };
    const { fetchImpl, refreshCalls } = singleUseRefreshFetch();
    const provider = new OAuth2PKCEAuthProvider(
      createRuntime(),
      undefined,
      store,
      fetchImpl as unknown as typeof fetch,
    );

    const settled = Promise.allSettled([
      provider.getAccessToken(),
      provider.getAccessToken(),
    ]);
    // Let caller A's refresh + save complete (all microtasks) before caller B's
    // outstanding store read resolves with the now-stale snapshot.
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseSecondLoad();
    const results = await settled;

    // Neither caller re-spends R0; only the original refresh happened.
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(refreshCalls).toEqual(["R0"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const values = results.map((r) =>
      r.status === "fulfilled" ? r.value : null,
    );
    expect(new Set(values)).toEqual(new Set(["A1"]));
    expect(store.save).toHaveBeenCalledTimes(1);
  });

  it("refreshes again after the rotated token itself expires", async () => {
    // Each issued token lands inside the 30s expiry skew (expires_in: 1), so the
    // second sequential call must run a fresh refresh rather than hand back the
    // still-in-flight promise. This exercises obtainTokens on a *second* expiry
    // cycle. Because the two calls are sequential, the first flight has already
    // settled and `authInFlight` is null by the time the second call runs, so
    // this case pins the `.finally()` cleanup alone — not the concurrent join
    // branch, which it never enters. It only passes when `.finally()` clears
    // `authInFlight` after the first flight settles; without that cleanup
    // `authInFlight` keeps a settled, expired promise and every later call
    // returns the stale token, never refreshing. (A concurrent second-cycle
    // race that also exercises the join branch's expiry re-check is separate.)
    const { fetchImpl, refreshCalls } = singleUseRefreshFetch({ expiresIn: 1 });
    const provider = new OAuth2PKCEAuthProvider(
      createRuntime(),
      undefined,
      createStore(expiredTokens()),
      fetchImpl as unknown as typeof fetch,
    );

    // First cycle spends R0 -> A1/R1; A1 is already inside the skew window.
    expect(await provider.getAccessToken()).toBe("A1");
    // Second cycle must observe A1 as expired and spend R1 -> A2/R2.
    expect(await provider.getAccessToken()).toBe("A2");
    expect(refreshCalls).toEqual(["R0", "R1"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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
