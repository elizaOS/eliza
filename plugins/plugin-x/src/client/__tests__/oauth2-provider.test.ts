import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OAuth2PKCEAuthProvider } from "../auth-providers/oauth2-pkce";
import type {
  StoredOAuth2Tokens,
  TokenStore,
} from "../auth-providers/token-store";

type MockRuntime = Pick<IAgentRuntime, "agentId"> & {
  getSetting: IAgentRuntime["getSetting"];
  getCache: IAgentRuntime["getCache"];
  setCache: IAgentRuntime["setCache"];
};

describe("OAuth2PKCEAuthProvider", () => {
  let runtime: MockRuntime;

  beforeEach(() => {
    runtime = {
      agentId: "agent-1" as IAgentRuntime["agentId"],
      getSetting: vi.fn((k: string) => {
        const settings: Record<string, string> = {
          TWITTER_AUTH_MODE: "oauth",
          TWITTER_CLIENT_ID: "client-id",
          TWITTER_REDIRECT_URI: "http://127.0.0.1:8080/callback",
        };
        return settings[k];
      }) as IAgentRuntime["getSetting"],
      getCache: vi.fn() as IAgentRuntime["getCache"],
      setCache: vi.fn() as IAgentRuntime["setCache"],
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

    const fetchImpl: typeof fetch = vi.fn() as unknown as typeof fetch;
    const provider = new OAuth2PKCEAuthProvider(
      runtime as IAgentRuntime,
      store,
      fetchImpl,
    );

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
        scope: "tweet.read",
      }),
    })) as unknown as typeof fetch;

    const provider = new OAuth2PKCEAuthProvider(
      runtime as IAgentRuntime,
      store,
      fetchImpl,
    );

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
    })) as unknown as typeof fetch;

    const provider = new OAuth2PKCEAuthProvider(
      runtime as IAgentRuntime,
      store,
      fetchImpl,
    );

    await expect(provider.getAccessToken()).rejects.toThrow(
      "Twitter token refresh failed",
    );
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
    })) as unknown as typeof fetch;

    const provider = new OAuth2PKCEAuthProvider(
      runtime as IAgentRuntime,
      store,
      fetchImpl,
      async () => {
        // stub interactiveLogin: force a call to the token endpoint so we
        // exercise the real exchange-failure path.
        const res = (await (
          fetchImpl as unknown as (
            input: string,
            init: RequestInit,
          ) => Promise<{ status: number; json: () => Promise<unknown> }>
        )("https://api.twitter.com/2/oauth2/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "grant_type=authorization_code",
        })) as { status: number; json: () => Promise<unknown> };
        const body = await res.json();
        throw new Error(
          `Twitter token exchange failed (${res.status}): ${JSON.stringify(body)}`,
        );
      },
    );

    await expect(provider.getAccessToken()).rejects.toThrow(
      'Twitter token exchange failed (401): {"error":"unauthorized_client"}',
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
    })) as unknown as typeof fetch;

    const provider = new OAuth2PKCEAuthProvider(
      runtime as IAgentRuntime,
      store,
      fetchImpl,
    );
    const token = await provider.getAccessToken();
    expect(token).toBe("new-access");

    expect(store.save).toHaveBeenCalledWith(
      expect.objectContaining({ refresh_token: "refresh-new" }),
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
      runtime as IAgentRuntime,
      store,
      vi.fn() as unknown as typeof fetch,
      interactiveLoginFn,
    );

    const token = await provider.getAccessToken();
    expect(token).toBe("new");
    expect(store.clear).toHaveBeenCalled();
    expect(interactiveLoginFn).toHaveBeenCalled();
  });
});
