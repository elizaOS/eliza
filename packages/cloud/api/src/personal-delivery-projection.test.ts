/** Exercises sender projection persistence, coherence, and Dedicated fail-open avoidance. */

import { describe, expect, mock, test } from "bun:test";
import { personalDeliveryProjectionObjectName } from "@/lib/services/eliza-app/personal-delivery-projection-contract";
import type {
  PersonalDeliveryInput,
  PersonalDeliveryProjectionHint,
  PersonalDeliveryResult,
} from "@/lib/services/eliza-app/user-service";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  PersonalDeliveryProjection,
  resolvePersonalDeliveryProjection,
} from "./personal-delivery-projection";

class MemoryStorage {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
}

function state(storage = new MemoryStorage()): {
  durableState: DurableObjectState;
  storage: MemoryStorage;
} {
  return {
    durableState: {
      storage,
      id: { name: personalDeliveryProjectionObjectName("telegram", "123456") },
    } as unknown as DurableObjectState,
    storage,
  };
}

const ENV = {} as AppEnv["Bindings"];
const USER_ID = "11111111-1111-4111-8111-111111111111";
const REPLACEMENT_USER_ID = "22222222-2222-4222-8222-222222222222";
const RIGHTFUL_USER_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_USER_ID = "44444444-4444-4444-8444-444444444444";
const CACHE_KEY = "verified-user-hint:v1";
const TELEGRAM: PersonalDeliveryInput = {
  platform: "telegram",
  telegramId: "123456",
  username: "nubs",
  displayName: "Nubs",
};

function request(path: "/resolve" | "/invalidate", body?: unknown): Request {
  return new Request(`https://personal-delivery-projection${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function sharedResult(): PersonalDeliveryResult {
  return {
    userId: USER_ID,
    organizationId: "org-1",
    dedicatedTarget: null,
    isNew: false,
    resolution: "single-query-repeat" as const,
  };
}

function projectionHitResult(
  overrides: Partial<PersonalDeliveryResult> = {},
): PersonalDeliveryResult {
  return {
    ...sharedResult(),
    resolution: "sender-projection-hit" as const,
    ...overrides,
  };
}

function testResolver(
  resolvePersonalDelivery: (
    params: PersonalDeliveryInput,
  ) => Promise<PersonalDeliveryResult>,
  revalidatePersonalDeliveryProjection: (
    params: PersonalDeliveryInput,
    expected: PersonalDeliveryProjectionHint,
  ) => Promise<PersonalDeliveryResult | null> = mock(async () =>
    projectionHitResult(),
  ),
) {
  return { resolvePersonalDelivery, revalidatePersonalDeliveryProjection };
}

describe("PersonalDeliveryProjection", () => {
  test("hydrates once and serves repeat Shared turns from durable sender state", async () => {
    const memory = state();
    const resolvePersonalDelivery = mock(async () => sharedResult());
    const object = new PersonalDeliveryProjection(
      memory.durableState,
      ENV,
      testResolver(resolvePersonalDelivery),
    );

    const cold = await object.fetch(request("/resolve", TELEGRAM));
    const warm = await object.fetch(request("/resolve", TELEGRAM));

    expect(cold.status).toBe(200);
    expect(await cold.json()).toMatchObject({
      resolution: "single-query-repeat",
    });
    expect((await warm.json()) as Record<string, unknown>).toEqual({
      userId: USER_ID,
      organizationId: "org-1",
      dedicatedTarget: null,
      isNew: false,
      resolution: "sender-projection-hit",
    });
    expect(resolvePersonalDelivery).toHaveBeenCalledTimes(1);
  });

  test("survives object eviction through Durable Object storage", async () => {
    const memory = state();
    const firstResolver = mock(async () => sharedResult());
    const first = new PersonalDeliveryProjection(
      memory.durableState,
      ENV,
      testResolver(firstResolver),
    );
    await first.fetch(request("/resolve", TELEGRAM));

    const afterEvictionResolver = mock(async () => sharedResult());
    const afterEviction = new PersonalDeliveryProjection(
      memory.durableState,
      ENV,
      testResolver(afterEvictionResolver),
    );
    const response = await afterEviction.fetch(request("/resolve", TELEGRAM));

    expect(await response.json()).toMatchObject({
      resolution: "sender-projection-hit",
    });
    expect(afterEvictionResolver).not.toHaveBeenCalled();
  });

  test("rehydrates after the hard safety expiry", async () => {
    const memory = state();
    const firstResolver = mock(async () => sharedResult());
    const first = new PersonalDeliveryProjection(
      memory.durableState,
      ENV,
      testResolver(firstResolver),
    );
    await first.fetch(request("/resolve", TELEGRAM));
    const stored = memory.storage.values.get(CACHE_KEY) as Record<
      string,
      unknown
    >;
    memory.storage.values.set(CACHE_KEY, { ...stored, expiresAt: 0 });

    const expiredResolver = mock(async () => sharedResult());
    const afterExpiry = new PersonalDeliveryProjection(
      memory.durableState,
      ENV,
      testResolver(expiredResolver),
    );
    const response = await afterExpiry.fetch(request("/resolve", TELEGRAM));

    expect(await response.json()).toMatchObject({
      resolution: "single-query-repeat",
    });
    expect(expiredResolver).toHaveBeenCalledTimes(1);
  });

  test("refreshes when the trusted transport profile changes", async () => {
    const memory = state();
    const resolvePersonalDelivery = mock(async () => sharedResult());
    const object = new PersonalDeliveryProjection(
      memory.durableState,
      ENV,
      testResolver(resolvePersonalDelivery),
    );
    await object.fetch(request("/resolve", TELEGRAM));
    await object.fetch(
      request("/resolve", { ...TELEGRAM, username: "nubs-renamed" }),
    );

    expect(resolvePersonalDelivery).toHaveBeenCalledTimes(2);
  });

  test("never caches a Dedicated target with mutable lifecycle fields", async () => {
    const memory = state();
    const resolvePersonalDelivery = mock(async () => ({
      ...sharedResult(),
      dedicatedTarget: {
        id: "dedicated-1",
        status: "running" as const,
        bridge_url: "https://agent.example",
        agent_config: { __agentUpgradedFrom: "personal:user-1:org-1" },
      },
    }));
    const object = new PersonalDeliveryProjection(
      memory.durableState,
      ENV,
      testResolver(resolvePersonalDelivery),
    );

    await object.fetch(request("/resolve", TELEGRAM));
    await object.fetch(request("/resolve", TELEGRAM));

    expect(resolvePersonalDelivery).toHaveBeenCalledTimes(2);
    expect(memory.storage.values.size).toBe(0);
  });

  test("explicit invalidation makes the next turn rehydrate", async () => {
    const memory = state();
    const resolvePersonalDelivery = mock(async () => sharedResult());
    const object = new PersonalDeliveryProjection(
      memory.durableState,
      ENV,
      testResolver(resolvePersonalDelivery),
    );
    await object.fetch(request("/resolve", TELEGRAM));

    expect((await object.fetch(request("/invalidate"))).status).toBe(200);
    await object.fetch(request("/resolve", TELEGRAM));

    expect(resolvePersonalDelivery).toHaveBeenCalledTimes(2);
  });

  test("serializes concurrent cold turns into one database hydration", async () => {
    const memory = state();
    const resolvePersonalDelivery = mock(async () => {
      await Promise.resolve();
      return sharedResult();
    });
    const object = new PersonalDeliveryProjection(
      memory.durableState,
      ENV,
      testResolver(resolvePersonalDelivery),
    );

    const responses = await Promise.all([
      object.fetch(request("/resolve", TELEGRAM)),
      object.fetch(request("/resolve", TELEGRAM)),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(resolvePersonalDelivery).toHaveBeenCalledTimes(1);
  });

  test("rejects malformed sender input before database work", async () => {
    const memory = state();
    const resolvePersonalDelivery = mock(async () => sharedResult());
    const object = new PersonalDeliveryProjection(
      memory.durableState,
      ENV,
      testResolver(resolvePersonalDelivery),
    );

    const response = await object.fetch(
      request("/resolve", { platform: "telegram" }),
    );

    expect(response.status).toBe(400);
    expect(resolvePersonalDelivery).not.toHaveBeenCalled();
  });

  for (const revocation of [
    "old handle relink",
    "user deactivation",
    "user deletion",
    "organization deactivation",
    "organization deletion",
  ]) {
    test(`rejects a cached candidate after ${revocation}`, async () => {
      const memory = state();
      const initial = mock(async () => sharedResult());
      await new PersonalDeliveryProjection(
        memory.durableState,
        ENV,
        testResolver(initial),
      ).fetch(request("/resolve", TELEGRAM));

      const canonical = mock(async () => ({
        ...sharedResult(),
        userId: REPLACEMENT_USER_ID,
        organizationId: "replacement-org",
      }));
      const revalidate = mock(async () => null);
      const response = await new PersonalDeliveryProjection(
        memory.durableState,
        ENV,
        testResolver(canonical, revalidate),
      ).fetch(request("/resolve", TELEGRAM));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        userId: REPLACEMENT_USER_ID,
        organizationId: "replacement-org",
      });
      expect(revalidate).toHaveBeenCalledWith(TELEGRAM, { userId: USER_ID });
      expect(canonical).toHaveBeenCalledTimes(1);
      expect(memory.storage.values.get(CACHE_KEY)).toMatchObject({
        candidateUserId: REPLACEMENT_USER_ID,
      });
    });
  }

  test("derives a moved user's current organization from the database snapshot", async () => {
    const memory = state();
    await new PersonalDeliveryProjection(
      memory.durableState,
      ENV,
      testResolver(mock(async () => sharedResult())),
    ).fetch(request("/resolve", TELEGRAM));
    const canonical = mock(async () => sharedResult());
    const revalidate = mock(async () =>
      projectionHitResult({ organizationId: "current-org" }),
    );

    const response = await new PersonalDeliveryProjection(
      memory.durableState,
      ENV,
      testResolver(canonical, revalidate),
    ).fetch(request("/resolve", TELEGRAM));

    expect(await response.json()).toMatchObject({
      userId: USER_ID,
      organizationId: "current-org",
    });
    expect(canonical).not.toHaveBeenCalled();
  });

  test("never trusts a poisoned victim hint when revalidation returns another user", async () => {
    const memory = state();
    await new PersonalDeliveryProjection(
      memory.durableState,
      ENV,
      testResolver(mock(async () => sharedResult())),
    ).fetch(request("/resolve", TELEGRAM));
    const canonical = mock(async () => ({
      ...sharedResult(),
      userId: RIGHTFUL_USER_ID,
      organizationId: "rightful-org",
    }));
    const mismatched = mock(async () =>
      projectionHitResult({
        userId: OTHER_USER_ID,
        organizationId: "victim-org",
      }),
    );

    const response = await new PersonalDeliveryProjection(
      memory.durableState,
      ENV,
      testResolver(canonical, mismatched),
    ).fetch(request("/resolve", TELEGRAM));

    expect(await response.json()).toMatchObject({
      userId: RIGHTFUL_USER_ID,
      organizationId: "rightful-org",
    });
    expect(canonical).toHaveBeenCalledTimes(1);
  });

  test("uses a newly authoritative Dedicated target and evicts the Shared hint", async () => {
    const memory = state();
    await new PersonalDeliveryProjection(
      memory.durableState,
      ENV,
      testResolver(mock(async () => sharedResult())),
    ).fetch(request("/resolve", TELEGRAM));
    const dedicated = {
      id: "dedicated-1",
      status: "running" as const,
      bridge_url: "https://agent.example",
      agent_config: { __agentUpgradedFrom: "personal:user-1:org-1" },
    };

    const response = await new PersonalDeliveryProjection(
      memory.durableState,
      ENV,
      testResolver(
        mock(async () => sharedResult()),
        mock(async () => projectionHitResult({ dedicatedTarget: dedicated })),
      ),
    ).fetch(request("/resolve", TELEGRAM));

    expect(await response.json()).toMatchObject({ dedicatedTarget: dedicated });
    expect(memory.storage.values.has(CACHE_KEY)).toBe(false);
  });

  for (const malformed of [
    {
      profileKey: "legacy",
      userId: USER_ID,
      organizationId: "org-1",
      expiresAt: Date.now() + 1_000,
    },
    {
      version: 0,
      profileKey: "legacy",
      candidateUserId: USER_ID,
      expiresAt: Date.now() + 1_000,
    },
    {
      version: 1,
      profileKey: "x".repeat(4_097),
      candidateUserId: USER_ID,
      expiresAt: Date.now() + 1_000,
    },
  ]) {
    test("evicts malformed, old-version, or oversized persisted hints", async () => {
      const memory = state();
      memory.storage.values.set(CACHE_KEY, malformed);
      const canonical = mock(async () => sharedResult());

      const response = await new PersonalDeliveryProjection(
        memory.durableState,
        ENV,
        testResolver(canonical),
      ).fetch(request("/resolve", TELEGRAM));

      expect(response.status).toBe(200);
      expect(canonical).toHaveBeenCalledTimes(1);
      expect(memory.storage.values.get(CACHE_KEY)).toMatchObject({
        version: 1,
        candidateUserId: USER_ID,
      });
    });
  }

  test("keeps rollback generations on separate storage keys", async () => {
    const memory = state();
    memory.storage.values.set("shared-account", {
      profileKey: "legacy",
      userId: "legacy-user",
      organizationId: "legacy-org",
      expiresAt: Date.now() + 1_000,
    });
    const canonical = mock(async () => sharedResult());

    const response = await new PersonalDeliveryProjection(
      memory.durableState,
      ENV,
      testResolver(canonical),
    ).fetch(request("/resolve", TELEGRAM));

    expect(response.status).toBe(200);
    expect(canonical).toHaveBeenCalledTimes(1);
    expect(memory.storage.values.has("shared-account")).toBe(false);
    expect(memory.storage.values.get(CACHE_KEY)).toMatchObject({
      version: 1,
      candidateUserId: USER_ID,
    });
  });

  test("fails closed on a database error while revalidating a hint", async () => {
    const memory = state();
    await new PersonalDeliveryProjection(
      memory.durableState,
      ENV,
      testResolver(mock(async () => sharedResult())),
    ).fetch(request("/resolve", TELEGRAM));
    const canonical = mock(async () => sharedResult());
    const revalidate = mock(async () => {
      throw new Error("database unavailable");
    });

    const response = await new PersonalDeliveryProjection(
      memory.durableState,
      ENV,
      testResolver(canonical, revalidate),
    ).fetch(request("/resolve", TELEGRAM));

    expect(response.status).toBe(502);
    expect(canonical).not.toHaveBeenCalled();
  });

  test("serializes invalidation behind an in-flight verified read", async () => {
    const memory = state();
    await new PersonalDeliveryProjection(
      memory.durableState,
      ENV,
      testResolver(mock(async () => sharedResult())),
    ).fetch(request("/resolve", TELEGRAM));
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const revalidate = mock(async () => {
      await gate;
      return projectionHitResult();
    });
    const object = new PersonalDeliveryProjection(
      memory.durableState,
      ENV,
      testResolver(
        mock(async () => sharedResult()),
        revalidate,
      ),
    );

    const resolving = object.fetch(request("/resolve", TELEGRAM));
    await Promise.resolve();
    const invalidating = object.fetch(request("/invalidate"));
    release?.();
    const [resolved, invalidated] = await Promise.all([
      resolving,
      invalidating,
    ]);

    expect(resolved.status).toBe(200);
    expect(invalidated.status).toBe(200);
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(memory.storage.values.has(CACHE_KEY)).toBe(false);
  });

  test("rejects a request delivered to another sender's object", async () => {
    const memory = state();
    const resolvePersonalDelivery = mock(async () => sharedResult());
    const response = await new PersonalDeliveryProjection(
      memory.durableState,
      ENV,
      testResolver(resolvePersonalDelivery),
    ).fetch(request("/resolve", { ...TELEGRAM, telegramId: "654321" }));

    expect(response.status).toBe(409);
    expect(resolvePersonalDelivery).not.toHaveBeenCalled();
  });
});

describe("resolvePersonalDeliveryProjection", () => {
  test("keeps Node and tests on the canonical database resolver when unbound", async () => {
    const resolvePersonalDelivery = mock(async () => sharedResult());
    const result = await resolvePersonalDeliveryProjection(ENV, TELEGRAM, {
      resolvePersonalDelivery,
    });

    expect(result).toEqual(sharedResult());
    expect(resolvePersonalDelivery).toHaveBeenCalledTimes(1);
  });

  test("uses the bound sender object without touching the database fallback", async () => {
    const fetch = mock(async () =>
      Response.json({ ...sharedResult(), resolution: "sender-projection-hit" }),
    );
    const getByName = mock(() => ({ fetch }));
    const resolvePersonalDelivery = mock(async () => sharedResult());

    const result = await resolvePersonalDeliveryProjection(
      {
        PERSONAL_DELIVERY_PROJECTIONS: { getByName },
        PERSONAL_DELIVERY_PROJECTION_READ_ENABLED: "true",
      } as unknown as AppEnv["Bindings"],
      TELEGRAM,
      { resolvePersonalDelivery },
    );

    expect(result.resolution).toBe("sender-projection-hit");
    expect(getByName).toHaveBeenCalledWith(
      personalDeliveryProjectionObjectName("telegram", "123456"),
    );
    expect(resolvePersonalDelivery).not.toHaveBeenCalled();
  });

  test("keeps reads canonical until invalidation writers are the rollback baseline", async () => {
    const getByName = mock(() => ({
      fetch: async () =>
        Response.json({
          ...sharedResult(),
          resolution: "sender-projection-hit",
        }),
    }));
    const resolvePersonalDelivery = mock(async () => sharedResult());

    const result = await resolvePersonalDeliveryProjection(
      {
        PERSONAL_DELIVERY_PROJECTIONS: { getByName },
      } as unknown as AppEnv["Bindings"],
      TELEGRAM,
      { resolvePersonalDelivery },
    );

    expect(result).toEqual(sharedResult());
    expect(resolvePersonalDelivery).toHaveBeenCalledTimes(1);
    expect(getByName).not.toHaveBeenCalled();
  });

  test("fails closed when a bound projection returns malformed state", async () => {
    const namespace = {
      getByName: () => ({
        fetch: async () => Response.json({ success: true }),
      }),
    };

    await expect(
      resolvePersonalDeliveryProjection(
        {
          PERSONAL_DELIVERY_PROJECTIONS: namespace,
          PERSONAL_DELIVERY_PROJECTION_READ_ENABLED: "true",
        } as unknown as AppEnv["Bindings"],
        TELEGRAM,
        { resolvePersonalDelivery: async () => sharedResult() },
      ),
    ).rejects.toThrow("Personal delivery projection failed with status 200");
  });
});
