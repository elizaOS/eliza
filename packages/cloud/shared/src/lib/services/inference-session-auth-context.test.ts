/**
 * Exercises the real inference-session cache while replacing only the
 * authoritative user/moderation stores, proving cold hydration is detached,
 * uses one combined cache read, and bypasses secondary user caches.
 */

process.env.MOCK_REDIS = "1";
process.env.CACHE_ENABLED = "true";
process.env.INFERENCE_STRONG_REVOCATION_ENABLED = "true";

import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

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
let assertSessionActive: () => Promise<void>;
const strongCredentialChecks: Array<Record<string, unknown>> = [];
const ADMISSION = {
  balance: { balanceUsd: 100, balanceAt: 1, balanceRevision: "1" },
  rateLimits: {
    completionsRpm: 60,
    embeddingsRpm: 100,
    standardRpm: 30,
    strictRpm: 5,
  },
};

mock.module("../auth/steward-client", () => ({
  verifyStewardTokenCached: async () => claims,
}));

mock.module("../../db/repositories/users", () => ({
  usersRepository: {
    findByStewardIdWithOrganizationForWrite: async () => {
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

mock.module("./inference-admission-snapshot", () => ({
  loadInferenceAdmissionSnapshot: async () => ADMISSION,
}));
mock.module("./inference-credential-revocation", () => ({
  isInferenceStrongRevocationEnabled: () =>
    process.env.INFERENCE_STRONG_REVOCATION_ENABLED === "true",
  InferenceCredentialRevokedError: class InferenceCredentialRevokedError extends Error {
    constructor(readonly reason: string) {
      super("Inference credential is revoked");
      this.name = "InferenceCredentialRevokedError";
    }
  },
  assertInferenceCredentialActive: (
    _organizationId: string,
    credential: Record<string, unknown>,
  ) => {
    if (process.env.INFERENCE_STRONG_REVOCATION_ENABLED !== "true") {
      return Promise.resolve();
    }
    strongCredentialChecks.push(credential);
    return assertSessionActive();
  },
  revokeInferenceApiKey: async () => undefined,
  setInferenceSessionBindingActive: async () => undefined,
  revokeInferenceSessionsThrough: async () => undefined,
  setInferenceOrganizationActive: async () => undefined,
  setInferenceSubjectActive: async () => undefined,
}));

const { __clearInferenceSessionAuthHydrations, resolveInferenceSessionAuthContext } = await import(
  "./inference-session-auth-context"
);
const { invalidateInferenceSessionAuthContext, readInferenceSessionAuthDecision } = await import(
  "./inference-auth-cache"
);
const { cache } = await import("../cache/client");
const { logger } = await import("../utils/logger");

function request(): Request {
  return new Request("https://api.example/api/v1/chat/completions", {
    headers: { authorization: "Bearer header.payload.signature" },
  });
}

beforeEach(async () => {
  process.env.INFERENCE_STRONG_REVOCATION_ENABLED = "true";
  __clearInferenceSessionAuthHydrations();
  claims = {
    userId: "steward-1",
    email: "person@example.test",
    expiration: Math.floor(Date.now() / 1000) + 300,
    issuedAt: Math.floor(Date.now() / 1000),
  };
  userReads = 0;
  moderationReads = 0;
  strongCredentialChecks.length = 0;
  assertSessionActive = async () => undefined;
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
    const cacheRead = spyOn(cache, "getWithOutcome");

    const result = await resolveInferenceSessionAuthContext(request(), {
      cacheOnly: true,
      useAuthCache: true,
      deferStrongCredentialCheck: true,
      executionCtx: { waitUntil: (promise) => waited.push(promise) },
    });

    expect(result).toMatchObject({ kind: "warming" });
    expect(result.kind === "warming" && result.hydration).toBeTruthy();
    expect(result.kind === "warming" && result.continuation).toBeTruthy();
    expect(waited).toHaveLength(1);
    expect(cacheRead).toHaveBeenCalledTimes(1);
    expect(userReads).toBe(1);
    expect(moderationReads).toBe(0);
    releaseUser();
    if (result.kind !== "warming" || !result.continuation) throw new Error("unreachable");
    await expect(result.continuation).resolves.toMatchObject({
      kind: "authorized",
      source: "origin",
      credential: {
        kind: "steward_session",
        userId: "user-1",
        stewardUserId: "steward-1",
        issuedAt: claims?.issuedAt,
      },
    });
    await Promise.all(waited);
    expect(moderationReads).toBe(1);
    expect(strongCredentialChecks).toHaveLength(1);
    expect(cacheRead).toHaveBeenCalledTimes(1);
    cacheRead.mockRestore();
  });

  test("warm verified session reads the combined cache and never calls users or moderation", async () => {
    const waited: Promise<unknown>[] = [];
    await resolveInferenceSessionAuthContext(request(), {
      cacheOnly: true,
      useAuthCache: true,
      executionCtx: { waitUntil: (promise) => waited.push(promise) },
    });
    await Promise.all(waited);
    userReads = 0;
    moderationReads = 0;

    const result = await resolveInferenceSessionAuthContext(request(), {
      cacheOnly: true,
      useAuthCache: true,
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
    expect(strongCredentialChecks.at(-1)).toEqual({
      kind: "steward_session",
      userId: "user-1",
      stewardUserId: "steward-1",
      issuedAt: claims?.issuedAt,
    });
  });

  test("warm verified session carries its signed credential into admission without a standalone check", async () => {
    const waited: Promise<unknown>[] = [];
    await resolveInferenceSessionAuthContext(request(), {
      cacheOnly: true,
      useAuthCache: true,
      executionCtx: { waitUntil: (promise) => waited.push(promise) },
    });
    await Promise.all(waited);
    strongCredentialChecks.length = 0;
    const cacheRead = spyOn(cache, "getWithOutcome");

    const result = await resolveInferenceSessionAuthContext(request(), {
      cacheOnly: true,
      useAuthCache: true,
      deferStrongCredentialCheck: true,
    });

    expect(result).toMatchObject({
      kind: "authorized",
      source: "cache",
      credential: {
        kind: "steward_session",
        userId: "user-1",
        stewardUserId: "steward-1",
        issuedAt: claims?.issuedAt,
      },
    });
    expect(cacheRead).toHaveBeenCalledTimes(1);
    expect(strongCredentialChecks).toHaveLength(0);
  });

  test("flag-off Steward auth never defers its signed credential into admission", async () => {
    const waited: Promise<unknown>[] = [];
    await resolveInferenceSessionAuthContext(request(), {
      cacheOnly: true,
      useAuthCache: true,
      executionCtx: { waitUntil: (promise) => waited.push(promise) },
    });
    await Promise.all(waited);
    process.env.INFERENCE_STRONG_REVOCATION_ENABLED = "false";
    strongCredentialChecks.length = 0;

    const result = await resolveInferenceSessionAuthContext(request(), {
      cacheOnly: true,
      useAuthCache: true,
      deferStrongCredentialCheck: true,
    });

    expect(result).toMatchObject({ kind: "authorized", source: "cache" });
    expect(result).not.toHaveProperty("credential");
    expect(strongCredentialChecks).toHaveLength(0);
  });

  test("warm verified session is denied when its issued-at cutoff is revoked", async () => {
    const waited: Promise<unknown>[] = [];
    await resolveInferenceSessionAuthContext(request(), {
      cacheOnly: true,
      useAuthCache: true,
      executionCtx: { waitUntil: (promise) => waited.push(promise) },
    });
    await Promise.all(waited);
    userReads = 0;
    moderationReads = 0;
    assertSessionActive = async () => {
      const { InferenceCredentialRevokedError } = await import("./inference-credential-revocation");
      throw new InferenceCredentialRevokedError("session_revoked");
    };

    const result = await resolveInferenceSessionAuthContext(request(), {
      cacheOnly: true,
      useAuthCache: true,
    });

    expect(result).toEqual({ kind: "rejected", status: 401 });
    expect(userReads).toBe(0);
    expect(moderationReads).toBe(0);
  });

  test("warm session is rejected when its stale Steward-to-Cloud binding is revoked", async () => {
    const waited: Promise<unknown>[] = [];
    await resolveInferenceSessionAuthContext(request(), {
      cacheOnly: true,
      useAuthCache: true,
      executionCtx: { waitUntil: (promise) => waited.push(promise) },
    });
    await Promise.all(waited);
    assertSessionActive = async () => {
      const { InferenceCredentialRevokedError } = await import("./inference-credential-revocation");
      throw new InferenceCredentialRevokedError("session_binding_revoked");
    };

    expect(
      await resolveInferenceSessionAuthContext(request(), {
        cacheOnly: true,
        useAuthCache: true,
      }),
    ).toEqual({ kind: "rejected", status: 401 });
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
        useAuthCache: true,
        executionCtx: { waitUntil: (promise) => firstWaited.push(promise) },
      }),
      resolveInferenceSessionAuthContext(request(), {
        cacheOnly: true,
        useAuthCache: true,
        executionCtx: { waitUntil: (promise) => secondWaited.push(promise) },
      }),
    ]);

    expect(first).toMatchObject({ kind: "warming" });
    expect(second).toMatchObject({ kind: "warming" });
    expect(userReads).toBe(1);
    expect(firstWaited).toHaveLength(1);
    expect(secondWaited).toHaveLength(1);

    releaseUser.resolve();
    await Promise.all([...firstWaited, ...secondWaited]);
    expect(moderationReads).toBe(1);
  });

  test("the session projection barrier prevents rehydration while its write is pending", async () => {
    let finishWrite = (): void => {};
    const writeSpy = spyOn(cache, "setWithOutcome").mockImplementation(
      async () =>
        await new Promise((resolve) => {
          finishWrite = () => resolve({ kind: "written" as const, backend: "memory" as const });
        }),
    );
    const firstWaited: Promise<unknown>[] = [];
    const secondWaited: Promise<unknown>[] = [];
    try {
      const first = await resolveInferenceSessionAuthContext(request(), {
        cacheOnly: true,
        useAuthCache: true,
        executionCtx: { waitUntil: (promise) => firstWaited.push(promise) },
      });
      if (first.kind !== "warming" || !first.continuation) throw new Error("unreachable");
      await expect(first.continuation).resolves.toMatchObject({ kind: "authorized" });

      const second = await resolveInferenceSessionAuthContext(request(), {
        cacheOnly: true,
        useAuthCache: true,
        executionCtx: { waitUntil: (promise) => secondWaited.push(promise) },
      });
      if (second.kind !== "warming" || !second.continuation) throw new Error("unreachable");
      await expect(second.continuation).resolves.toMatchObject({ kind: "authorized" });
      expect(userReads).toBe(1);
      expect(firstWaited).toHaveLength(1);
      expect(secondWaited).toHaveLength(1);
      expect(firstWaited[0]).toBe(secondWaited[0]);

      finishWrite();
      await Promise.all([...firstWaited, ...secondWaited]);
    } finally {
      finishWrite();
      writeSpy.mockRestore();
    }
  });

  test("flag-off origin resolution performs no session-auth cache write", async () => {
    const result = await resolveInferenceSessionAuthContext(request(), {
      cacheOnly: false,
      useAuthCache: false,
      deferStrongCredentialCheck: true,
    });

    expect(result).toMatchObject({
      kind: "authorized",
      source: "origin",
      ctx: { userId: "user-1", orgId: "org-1", stewardUserId: "steward-1" },
    });
    expect(result).not.toHaveProperty("credential");
    expect(userReads).toBe(1);
    // The authoritative decision must NOT have been persisted: the real cache
    // stays cold for the subject, so nothing exists for a later flag flip to
    // trust and a cache-gated resolution still has to hydrate from origin.
    await expect(readInferenceSessionAuthDecision("steward-1")).resolves.toBeNull();
  });

  test("flag-on origin resolution persists the decision (write stays gated, not removed)", async () => {
    const result = await resolveInferenceSessionAuthContext(request(), {
      cacheOnly: false,
      useAuthCache: true,
    });

    expect(result).toMatchObject({ kind: "authorized", source: "origin" });
    await expect(readInferenceSessionAuthDecision("steward-1")).resolves.toMatchObject({
      userId: "user-1",
      orgId: "org-1",
      stewardUserId: "steward-1",
    });
  });

  test("a rejected deferred session write is structured and does not reject waitUntil", async () => {
    const writeSpy = spyOn(cache, "setWithOutcome").mockRejectedValue(
      new TypeError("sensitive session backend detail"),
    );
    const warning = spyOn(logger, "warn").mockImplementation(() => undefined);
    const waited: Promise<unknown>[] = [];
    try {
      const result = await resolveInferenceSessionAuthContext(request(), {
        cacheOnly: true,
        useAuthCache: true,
        executionCtx: { waitUntil: (promise) => waited.push(promise) },
      });
      expect(result).toMatchObject({ kind: "warming" });
      await expect(Promise.all(waited)).resolves.toBeArray();
      expect(warning).toHaveBeenCalledWith(
        "[InferenceSessionAuth] Deferred cache projection failed",
        { errorName: "TypeError" },
      );
      expect(JSON.stringify(warning.mock.calls)).not.toContain("sensitive session backend detail");
    } finally {
      writeSpy.mockRestore();
      warning.mockRestore();
    }
  });

  test("invalid session is rejected without authoritative hydration", async () => {
    claims = null;

    await expect(
      resolveInferenceSessionAuthContext(request(), {
        cacheOnly: true,
        useAuthCache: true,
        executionCtx: { waitUntil: () => undefined },
      }),
    ).resolves.toEqual({ kind: "rejected", status: 401 });
    expect(userReads).toBe(0);
    expect(moderationReads).toBe(0);
  });
});
