/**
 * Exercises the real inference-session cache while replacing only the
 * authoritative user/moderation stores, proving cold hydration is detached and
 * warm session authorization performs no database service call.
 */

process.env.MOCK_REDIS = "1";
process.env.CACHE_ENABLED = "true";

import { beforeEach, describe, expect, mock, test } from "bun:test";

let claims: {
  userId: string;
  email: string;
  expiration: number;
  issuedAt: number;
} | null;
let getUser:
  | (() => Promise<{
      id: string;
      is_active: boolean;
      organization_id: string;
      organization: { is_active: boolean };
    }>)
  | undefined;
let userReads = 0;
let moderationReads = 0;

mock.module("../auth/steward-client", () => ({
  verifyStewardTokenCached: async () => claims,
}));

mock.module("./users", () => ({
  usersService: {
    getByStewardId: async () => {
      userReads++;
      return await getUser?.();
    },
  },
}));

mock.module("./admin", () => ({
  adminService: {
    shouldBlockUser: async () => {
      moderationReads++;
      return false;
    },
  },
}));

mock.module("../steward-sync", () => ({
  syncUserFromSteward: async () => undefined,
}));

const { __clearInferenceSessionAuthHydrations, resolveInferenceSessionAuthContext } = await import(
  "./inference-session-auth-context"
);
const { invalidateInferenceSessionAuthContext } = await import("./inference-auth-cache");

function request(): Request {
  return new Request("https://api.example/api/v1/chat/completions", {
    headers: { authorization: "Bearer header.payload.signature" },
  });
}

beforeEach(async () => {
  __clearInferenceSessionAuthHydrations();
  claims = {
    userId: "steward-1",
    email: "person@example.test",
    expiration: Math.floor(Date.now() / 1000) + 300,
    issuedAt: Math.floor(Date.now() / 1000),
  };
  userReads = 0;
  moderationReads = 0;
  getUser = async () => ({
    id: "user-1",
    is_active: true,
    organization_id: "org-1",
    organization: { is_active: true },
  });
  await invalidateInferenceSessionAuthContext("steward-1");
});

describe("resolveInferenceSessionAuthContext", () => {
  test("cold Worker request returns warming without joining authoritative hydration", async () => {
    let releaseUser = (): void => {};
    getUser = async () =>
      await new Promise((resolve) => {
        releaseUser = () =>
          resolve({
            id: "user-1",
            is_active: true,
            organization_id: "org-1",
            organization: { is_active: true },
          });
      });
    const waited: Promise<unknown>[] = [];

    const result = await resolveInferenceSessionAuthContext(request(), {
      cacheOnly: true,
      executionCtx: { waitUntil: (promise) => waited.push(promise) },
    });

    expect(result).toEqual({ kind: "warming" });
    expect(waited).toHaveLength(1);
    expect(userReads).toBe(1);
    expect(moderationReads).toBe(0);

    releaseUser();
    await Promise.all(waited);
    expect(moderationReads).toBe(1);
  });

  test("warm verified session reads the combined cache and never calls users or moderation", async () => {
    const waited: Promise<unknown>[] = [];
    await resolveInferenceSessionAuthContext(request(), {
      cacheOnly: true,
      executionCtx: { waitUntil: (promise) => waited.push(promise) },
    });
    await Promise.all(waited);
    userReads = 0;
    moderationReads = 0;

    const result = await resolveInferenceSessionAuthContext(request(), {
      cacheOnly: true,
    });

    expect(result).toMatchObject({
      kind: "authorized",
      source: "cache",
      ctx: {
        userId: "user-1",
        orgId: "org-1",
        apiKeyId: null,
        stewardUserId: "steward-1",
      },
    });
    expect(userReads).toBe(0);
    expect(moderationReads).toBe(0);
  });

  test("concurrent cold requests share one authoritative hydration", async () => {
    const releaseUser = Promise.withResolvers<void>();
    getUser = async () => {
      await releaseUser.promise;
      return {
        id: "user-1",
        is_active: true,
        organization_id: "org-1",
        organization: { is_active: true },
      };
    };
    const firstWaited: Promise<unknown>[] = [];
    const secondWaited: Promise<unknown>[] = [];

    const [first, second] = await Promise.all([
      resolveInferenceSessionAuthContext(request(), {
        cacheOnly: true,
        executionCtx: { waitUntil: (promise) => firstWaited.push(promise) },
      }),
      resolveInferenceSessionAuthContext(request(), {
        cacheOnly: true,
        executionCtx: { waitUntil: (promise) => secondWaited.push(promise) },
      }),
    ]);

    expect(first).toEqual({ kind: "warming" });
    expect(second).toEqual({ kind: "warming" });
    expect(userReads).toBe(1);
    expect(firstWaited).toHaveLength(1);
    expect(secondWaited).toHaveLength(1);

    releaseUser.resolve();
    await Promise.all([...firstWaited, ...secondWaited]);
    expect(moderationReads).toBe(1);
  });

  test("invalid session is rejected without authoritative hydration", async () => {
    claims = null;

    await expect(
      resolveInferenceSessionAuthContext(request(), {
        cacheOnly: true,
        executionCtx: { waitUntil: () => undefined },
      }),
    ).resolves.toEqual({ kind: "rejected", status: 401 });
    expect(userReads).toBe(0);
    expect(moderationReads).toBe(0);
  });
});
