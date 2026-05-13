import { afterEach, describe, expect, mock, test } from "bun:test";

type CacheRecord = {
  appId: string;
  userId: string;
  issuedAt: number;
  expiresAt: number;
};

type CacheOverrides = {
  getAndDelete?: ReturnType<typeof mock>;
  isAvailable?: ReturnType<typeof mock>;
  setIfNotExists?: ReturnType<typeof mock>;
};

function mockCache(overrides: CacheOverrides = {}) {
  const cache = {
    getAndDelete: overrides.getAndDelete ?? mock(async () => null),
    isAvailable: overrides.isAvailable ?? mock(() => true),
    setIfNotExists: overrides.setIfNotExists ?? mock(async () => true),
  };

  mock.module("@/lib/cache/client", () => ({ cache }));
  return cache;
}

async function importAppAuthCodes() {
  return import(
    new URL(
      `../../lib/services/app-auth-codes.ts?test=${Date.now()}-${Math.random()}`,
      import.meta.url,
    ).href
  );
}

describe("app auth authorization codes", () => {
  afterEach(() => {
    mock.restore();
  });

  test("issues an opaque single-use code and stores only a hashed cache key", async () => {
    const cache = mockCache();
    const { APP_AUTH_CODE_TTL_SECONDS, issueAppAuthCode, looksLikeAppAuthCode } =
      await importAppAuthCodes();

    const issued = await issueAppAuthCode({ appId: "app-1", userId: "user-1" });

    expect(looksLikeAppAuthCode(issued.code)).toBe(true);
    expect(issued.expiresIn).toBe(APP_AUTH_CODE_TTL_SECONDS);
    expect(new Date(issued.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(cache.setIfNotExists).toHaveBeenCalledTimes(1);

    const [cacheKey, record, ttlMs] = cache.setIfNotExists.mock.calls[0] as [
      string,
      CacheRecord,
      number,
    ];
    expect(cacheKey.startsWith("app:auth-code:")).toBe(true);
    expect(cacheKey).not.toContain(issued.code);
    expect(record).toMatchObject({ appId: "app-1", userId: "user-1" });
    expect(ttlMs).toBe(APP_AUTH_CODE_TTL_SECONDS * 1000);
  });

  test("consumes matching codes through get-and-delete", async () => {
    const record: CacheRecord = {
      appId: "app-1",
      userId: "user-1",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    const cache = mockCache({
      getAndDelete: mock(async () => record),
    });
    const { consumeAppAuthCode } = await importAppAuthCodes();

    await expect(consumeAppAuthCode("eac_test-code")).resolves.toEqual(record);

    expect(cache.getAndDelete).toHaveBeenCalledTimes(1);
    const [cacheKey] = cache.getAndDelete.mock.calls[0] as [string];
    expect(cacheKey.startsWith("app:auth-code:")).toBe(true);
    expect(cacheKey).not.toContain("eac_test-code");
  });

  test("rejects unavailable stores and expired records", async () => {
    mockCache({ isAvailable: mock(() => false) });
    const unavailable = await importAppAuthCodes();
    await expect(
      unavailable.issueAppAuthCode({ appId: "app-1", userId: "user-1" }),
    ).rejects.toThrow("App auth code store is unavailable");

    mock.restore();
    mockCache({
      getAndDelete: mock(async () => ({
        appId: "app-1",
        userId: "user-1",
        issuedAt: Date.now() - 120_000,
        expiresAt: Date.now() - 60_000,
      })),
    });
    const expired = await importAppAuthCodes();
    await expect(expired.consumeAppAuthCode("eac_expired")).resolves.toBeNull();
  });
});
