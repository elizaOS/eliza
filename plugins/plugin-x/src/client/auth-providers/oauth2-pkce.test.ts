/**
 * Regression coverage for the OAuth 2.0 PKCE callback boundary: the pasted
 * redirect must include the generated anti-CSRF state before token exchange.
 * Deterministic provider test; interactive I/O and token HTTP are mocked.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { promptForRedirectedUrl, waitForLoopbackCallback } from "./interactive";
import { OAuth2PKCEAuthProvider } from "./oauth2-pkce";
import { RuntimeCacheTokenStore, type TokenStore } from "./token-store";

vi.mock("./interactive", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./interactive")>()),
  waitForLoopbackCallback: vi.fn(async () => {
    throw new Error("loopback unavailable");
  }),
  promptForRedirectedUrl: vi.fn(
    async () => "http://127.0.0.1/callback?code=auth-code",
  ),
}));

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

function createStore(): TokenStore {
  return {
    load: vi.fn(async () => null),
    save: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  };
}

describe("OAuth2PKCEAuthProvider", () => {
  it("rejects a pasted redirect that omits state before exchanging the code", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new OAuth2PKCEAuthProvider(
      createRuntime(),
      undefined,
      createStore(),
      fetchImpl,
    );

    await expect(provider.getAccessToken()).rejects.toThrow(
      "OAuth state mismatch",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces a broken token cache instead of starting an interactive re-login", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    // The real backend store, driven through the provider the way the connector
    // uses it: `getCache` rejects, which is an outage and not "no tokens".
    const store = new RuntimeCacheTokenStore({
      agentId:
        "00000000-0000-0000-0000-000000000001" as IAgentRuntime["agentId"],
      getCache: vi.fn(async () => {
        throw new Error("cache backend is closed");
      }),
      setCache: vi.fn(async () => undefined),
    });
    const provider = new OAuth2PKCEAuthProvider(
      createRuntime(),
      undefined,
      store,
      fetchImpl,
    );

    // Before the fix `load()` caught this and answered `null`, so
    // `getAccessToken()` took the `!tokens` branch and entered the interactive
    // login below instead of reporting the broken backend.
    await expect(provider.getAccessToken()).rejects.toThrow(
      "cache backend is closed",
    );
    expect(waitForLoopbackCallback).not.toHaveBeenCalled();
    expect(promptForRedirectedUrl).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
