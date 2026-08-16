/** Exercises sender projection persistence, coherence, and Dedicated fail-open avoidance. */

import { describe, expect, mock, test } from "bun:test";
import type { PersonalDeliveryInput } from "@/lib/services/eliza-app/user-service";
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
    durableState: { storage } as unknown as DurableObjectState,
    storage,
  };
}

const ENV = {} as AppEnv["Bindings"];
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

function sharedResult() {
  return {
    userId: "user-1",
    organizationId: "org-1",
    dedicatedTarget: null,
    isNew: false,
    resolution: "single-query-repeat" as const,
  };
}

describe("PersonalDeliveryProjection", () => {
  test("hydrates once and serves repeat Shared turns from durable sender state", async () => {
    const memory = state();
    const resolvePersonalDelivery = mock(async () => sharedResult());
    const object = new PersonalDeliveryProjection(memory.durableState, ENV, {
      resolvePersonalDelivery,
    });

    const cold = await object.fetch(request("/resolve", TELEGRAM));
    const warm = await object.fetch(request("/resolve", TELEGRAM));

    expect(cold.status).toBe(200);
    expect(await cold.json()).toMatchObject({
      resolution: "single-query-repeat",
    });
    expect((await warm.json()) as Record<string, unknown>).toEqual({
      userId: "user-1",
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
    const first = new PersonalDeliveryProjection(memory.durableState, ENV, {
      resolvePersonalDelivery: firstResolver,
    });
    await first.fetch(request("/resolve", TELEGRAM));

    const afterEvictionResolver = mock(async () => sharedResult());
    const afterEviction = new PersonalDeliveryProjection(
      memory.durableState,
      ENV,
      {
        resolvePersonalDelivery: afterEvictionResolver,
      },
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
    const first = new PersonalDeliveryProjection(memory.durableState, ENV, {
      resolvePersonalDelivery: firstResolver,
    });
    await first.fetch(request("/resolve", TELEGRAM));
    const stored = memory.storage.values.get("shared-account") as Record<
      string,
      unknown
    >;
    memory.storage.values.set("shared-account", { ...stored, expiresAt: 0 });

    const expiredResolver = mock(async () => sharedResult());
    const afterExpiry = new PersonalDeliveryProjection(
      memory.durableState,
      ENV,
      {
        resolvePersonalDelivery: expiredResolver,
      },
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
    const object = new PersonalDeliveryProjection(memory.durableState, ENV, {
      resolvePersonalDelivery,
    });
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
    const object = new PersonalDeliveryProjection(memory.durableState, ENV, {
      resolvePersonalDelivery,
    });

    await object.fetch(request("/resolve", TELEGRAM));
    await object.fetch(request("/resolve", TELEGRAM));

    expect(resolvePersonalDelivery).toHaveBeenCalledTimes(2);
    expect(memory.storage.values.size).toBe(0);
  });

  test("explicit invalidation makes the next turn rehydrate", async () => {
    const memory = state();
    const resolvePersonalDelivery = mock(async () => sharedResult());
    const object = new PersonalDeliveryProjection(memory.durableState, ENV, {
      resolvePersonalDelivery,
    });
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
    const object = new PersonalDeliveryProjection(memory.durableState, ENV, {
      resolvePersonalDelivery,
    });

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
    const object = new PersonalDeliveryProjection(memory.durableState, ENV, {
      resolvePersonalDelivery,
    });

    const response = await object.fetch(
      request("/resolve", { platform: "telegram" }),
    );

    expect(response.status).toBe(400);
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
      } as unknown as AppEnv["Bindings"],
      TELEGRAM,
      { resolvePersonalDelivery },
    );

    expect(result.resolution).toBe("sender-projection-hit");
    expect(getByName).toHaveBeenCalledWith("telegram:123456");
    expect(resolvePersonalDelivery).not.toHaveBeenCalled();
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
        } as unknown as AppEnv["Bindings"],
        TELEGRAM,
        { resolvePersonalDelivery: async () => sharedResult() },
      ),
    ).rejects.toThrow("Personal delivery projection failed with status 200");
  });
});
