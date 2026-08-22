import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "crypto";
import { CacheTTL } from "../cache/keys";

const cacheSet = mock(async () => undefined);

mock.module("../cache/client", () => ({
  cache: { set: cacheSet },
}));

const { hashSessionToken, primeVerifiedUserSessionCache } = await import("./session-user-cache");

beforeEach(() => {
  cacheSet.mockClear();
});

describe("verified Steward user-session cache", () => {
  test("uses the canonical one-way token key and session-user TTL", async () => {
    const token = "verified-session-token";
    const user = {
      id: "cloud-user-1",
      organization_id: "org-1",
    } as Parameters<typeof primeVerifiedUserSessionCache>[1];
    const tokenHash = createHash("sha256").update(token).digest("hex").substring(0, 32);

    expect(hashSessionToken(token)).toBe(tokenHash);
    await primeVerifiedUserSessionCache(token, user);

    expect(cacheSet).toHaveBeenCalledWith(
      `session:user:${tokenHash}:v1`,
      user,
      CacheTTL.session.user,
    );
  });
});
