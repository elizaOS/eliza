/**
 * Covers OAuth token persistence: a cache read that throws must not be reported
 * as "no tokens are stored", because `OAuth2PKCEAuthProvider.getAccessToken()`
 * answers that with an interactive re-login.
 */
import { describe, expect, it } from "vitest";
import { RuntimeCacheTokenStore, type StoredOAuth2Tokens } from "./token-store";

const TOKENS: StoredOAuth2Tokens = {
  access_token: "access-1",
  refresh_token: "refresh-1",
  expires_at: 1_700_000_000_000,
};

type RuntimeTokenCache = ConstructorParameters<
  typeof RuntimeCacheTokenStore
>[0];

function storeWith(
  getCache: (key: string) => Promise<unknown>,
): RuntimeCacheTokenStore {
  const runtime = {
    agentId: "agent-1",
    getCache,
    setCache: async () => undefined,
  } as unknown as RuntimeTokenCache;
  return new RuntimeCacheTokenStore(runtime, "default");
}

describe("RuntimeCacheTokenStore", () => {
  it("propagates a cache read failure instead of reporting no stored tokens", async () => {
    const store = storeWith(async () => {
      throw new Error("cache backend is closed");
    });

    // A failed read is a broken store, not "this account has no tokens":
    // the auth provider would otherwise start an interactive re-login.
    await expect(store.load()).rejects.toThrow(/cache backend is closed/);
  });

  it("treats a missing token set as absent", async () => {
    expect(await storeWith(async () => undefined).load()).toBeNull();
    expect(await storeWith(async () => null).load()).toBeNull();
  });

  it("returns the stored token set", async () => {
    const store = storeWith(async () => TOKENS);

    await expect(store.load()).resolves.toEqual(TOKENS);
  });
});
