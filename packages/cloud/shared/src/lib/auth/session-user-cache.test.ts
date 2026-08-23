/**
 * Verifies the canonical authorization-bearing Steward session projection.
 * The cache address must use the complete one-way token digest, and priming
 * must preserve the ordinary session-user TTL and projection shape.
 */

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
    const tokenHash = createHash("sha256").update(token).digest("hex");

    expect(hashSessionToken(token)).toBe(tokenHash);
    await primeVerifiedUserSessionCache(token, user);

    expect(cacheSet).toHaveBeenCalledWith(
      `session:user:${tokenHash}:v1`,
      user,
      CacheTTL.session.user,
    );
  });
});
