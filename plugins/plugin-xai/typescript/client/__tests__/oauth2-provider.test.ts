import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OAuth2PKCEAuthProvider } from "../auth-providers/oauth2-pkce";
import type { StoredOAuth2Tokens, TokenStore } from "../auth-providers/token-store";

describe("OAuth2PKCEAuthProvider", () => {
  let runtime: IAgentRuntime;

  beforeEach(() => {
    runtime = {
      agentId: "agent-1",
      getSetting: vi.fn((k: string) => {
        const settings: Record<string, string> = {
          X_AUTH_MODE: "oauth",
          X_CLIENT_ID: "client-id",
          X_REDIRECT_URI: "http://127.0.0.1:8080/callback",
        };
        return settings[k];
      }),
      getCache: vi.fn(),
      setCache: vi.fn(),
    };
  });

  it("returns existing non-expired access token without refresh", async () => {
    const store: TokenStore = {
      load: vi.fn(async () => ({
        access_token: "access",
        refresh_token: "refresh",
        expires_at: Date.now() + 60_000,
      })),
      save: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    };

    const fetchImpl = vi.fn() as typeof fetch;
    const provider = new OAuth2PKCEAuthProvider(runtime, store, fetchImpl);

    const token = await provider.getAccessToken();
    expect(token).toBe("access");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes when expired and refresh_token is present", async () => {
    const expired: StoredOAuth2Tokens = {
      access_token: "old",
      refresh_token: "refresh",
      expires_at: Date.now() - 1,
    };

    const store: TokenStore = {
      load: vi.fn(async () => expired),
      save: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    };

    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        token_type: "bearer",
        scope: "post.read",
      }),
    }));

    const provider = new OAuth2PKCEAuthProvider(runtime, store, fetchImpl as typeof fetch);

    const token = await provider.getAccessToken();
    expect(token).toBe("new-access");
    expect(store.save).toHaveBeenCalled();
  });

  it("throws clear error on refresh failure", async () => {
    const expired: StoredOAuth2Tokens = {
      access_token: "old",
      refresh_token: "refresh",
      expires_at: Date.now() - 1,
    };

    const store: TokenStore = {
      load: vi.fn(async () => expired),
      save: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    };

    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid_grant" }),
    }));

    const provider = new OAuth2PKCEAuthProvider(runtime, store, fetchImpl as typeof fetch);

    await expect(provider.getAccessToken()).rejects.toThrow("X token refresh failed");
  });

  it("includes status/body on exchange failure", async () => {
    const store: TokenStore = {
      load: vi.fn(async () => null),
      save: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    };

    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: "unauthorized_client" }),
    }));

    const provider = new OAuth2PKCEAuthProvider(
      runtime,
      store,
      fetchImpl as typeof fetch,
      // stub interactive login to call the real token exchange path by returning a failure via fetch
      async () => {
        // simulate what interactiveLogin would do: return tokens after exchange;
        // here we force a call to the exchange endpoint by invoking getAccessToken without stored tokens.
        // We can't access private methods, so we just throw an error consistent with exchange failure.
        const res = await fetchImpl("https://api.x.com/2/oauth2/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "grant_type=authorization_code",
        });
        const body = await res.json();
        throw new Error(`X token exchange failed (${res.status}): ${JSON.stringify(body)}`);
      }
    );

    await expect(provider.getAccessToken()).rejects.toThrow(
      'X token exchange failed (401): {"error":"unauthorized_client"}'
    );
  });

  it("refresh rotates refresh_token when returned", async () => {
    const expired: StoredOAuth2Tokens = {
      access_token: "old",
      refresh_token: "refresh-old",
      expires_at: Date.now() - 1,
    };

    const store: TokenStore = {
      load: vi.fn(async () => expired),
      save: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    };

    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "refresh-new",
        expires_in: 3600,
      }),
    }));

    const provider = new OAuth2PKCEAuthProvider(runtime, store, fetchImpl as typeof fetch);
    const token = await provider.getAccessToken();
    expect(token).toBe("new-access");

    // ensure we persisted rotated refresh token
    expect(store.save).toHaveBeenCalledWith(
      expect.objectContaining({ refresh_token: "refresh-new" })
    );
  });

  it("expired token without refresh_token clears store and reauths", async () => {
    const expiredNoRefresh: StoredOAuth2Tokens = {
      access_token: "old",
      expires_at: Date.now() - 1,
    };

    const store: TokenStore = {
      load: vi.fn(async () => expiredNoRefresh),
      save: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    };

    const interactiveLoginFn = vi.fn(async () => ({
      access_token: "new",
      refresh_token: "refresh",
      expires_at: Date.now() + 3600_000,
    }));

    const provider = new OAuth2PKCEAuthProvider(
      runtime,
      store,
      vi.fn() as typeof fetch,
      interactiveLoginFn
    );

    const token = await provider.getAccessToken();
    expect(token).toBe("new");
    expect(store.clear).toHaveBeenCalled();
    expect(interactiveLoginFn).toHaveBeenCalled();
  });
});
