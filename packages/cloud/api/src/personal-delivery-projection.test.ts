/** Exercises sender projection persistence, coherence, and Dedicated fail-open avoidance. */

import { describe, expect, mock, test } from "bun:test";
import type { PersonalDeliveryInput } from "@/lib/services/eliza-app/user-service";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  PersonalDeliveryAccountResolutionError,
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
const PHONE: PersonalDeliveryInput = {
  platform: "phone",
  phoneNumber: "+15551234567",
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

  test("shares one verified-phone projection across Blooio and Twilio", async () => {
    const memory = state();
    const resolvePersonalDelivery = mock(async () => sharedResult());
    const object = new PersonalDeliveryProjection(memory.durableState, ENV, {
      resolvePersonalDelivery,
    });

    const cold = await object.fetch(request("/resolve", PHONE));
    const warm = await object.fetch(request("/resolve", PHONE));

    expect(cold.status).toBe(200);
    expect(await warm.json()).toMatchObject({
      resolution: "sender-projection-hit",
      userId: "user-1",
      organizationId: "org-1",
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
        PERSONAL_DELIVERY_PROJECTION_READ_ENABLED: "true",
      } as unknown as AppEnv["Bindings"],
      TELEGRAM,
      { resolvePersonalDelivery },
    );

    expect(result.resolution).toBe("sender-projection-hit");
    expect(getByName).toHaveBeenCalledWith("telegram:123456");
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

  test("bounds the projection read with an abort signal", async () => {
    let signal: unknown;
    const namespace = {
      getByName: () => ({
        fetch: async (_url: string, init: RequestInit) => {
          signal = init.signal;
          return Response.json({
            ...sharedResult(),
            resolution: "sender-projection-hit",
          });
        },
      }),
    };

    await resolvePersonalDeliveryProjection(
      {
        PERSONAL_DELIVERY_PROJECTIONS: namespace,
        PERSONAL_DELIVERY_PROJECTION_READ_ENABLED: "true",
      } as unknown as AppEnv["Bindings"],
      TELEGRAM,
      { resolvePersonalDelivery: async () => sharedResult() },
    );

    expect(signal).toBeInstanceOf(AbortSignal);
  });

  test("degrades a malformed projection result to the canonical resolver", async () => {
    const namespace = {
      getByName: () => ({
        fetch: async () => Response.json({ success: true }),
      }),
    };
    const resolvePersonalDelivery = mock(async () => sharedResult());

    const result = await resolvePersonalDeliveryProjection(
      {
        PERSONAL_DELIVERY_PROJECTIONS: namespace,
        PERSONAL_DELIVERY_PROJECTION_READ_ENABLED: "true",
      } as unknown as AppEnv["Bindings"],
      TELEGRAM,
      { resolvePersonalDelivery },
    );

    expect(result).toEqual(sharedResult());
    expect(resolvePersonalDelivery).toHaveBeenCalledTimes(1);
  });

  test("degrades a projection 502 to the canonical resolver in one attempt", async () => {
    const namespace = {
      getByName: () => ({
        fetch: async () =>
          Response.json(
            {
              error: "Personal delivery resolution failed",
              failureName: "TypeError",
            },
            { status: 502 },
          ),
      }),
    };
    const resolvePersonalDelivery = mock(async () => sharedResult());

    const result = await resolvePersonalDeliveryProjection(
      {
        PERSONAL_DELIVERY_PROJECTIONS: namespace,
        PERSONAL_DELIVERY_PROJECTION_READ_ENABLED: "true",
      } as unknown as AppEnv["Bindings"],
      TELEGRAM,
      { resolvePersonalDelivery },
    );

    expect(result).toEqual(sharedResult());
    expect(resolvePersonalDelivery).toHaveBeenCalledTimes(1);
  });

  test("degrades a projection transport failure to the canonical resolver", async () => {
    const namespace = {
      getByName: () => ({
        fetch: async () => {
          throw new DOMException("The operation timed out.", "TimeoutError");
        },
      }),
    };
    const resolvePersonalDelivery = mock(async () => sharedResult());

    const result = await resolvePersonalDeliveryProjection(
      {
        PERSONAL_DELIVERY_PROJECTIONS: namespace,
        PERSONAL_DELIVERY_PROJECTION_READ_ENABLED: "true",
      } as unknown as AppEnv["Bindings"],
      TELEGRAM,
      { resolvePersonalDelivery },
    );

    expect(result).toEqual(sharedResult());
    expect(resolvePersonalDelivery).toHaveBeenCalledTimes(1);
  });

  test("throws typed classification only after both paths fail", async () => {
    const namespace = {
      getByName: () => ({
        fetch: async () =>
          Response.json(
            {
              error: "Personal delivery resolution failed",
              failureName: "TypeError",
            },
            { status: 502 },
          ),
      }),
    };
    const databaseFailure = new Error("connection reset");

    const attempt = resolvePersonalDeliveryProjection(
      {
        PERSONAL_DELIVERY_PROJECTIONS: namespace,
        PERSONAL_DELIVERY_PROJECTION_READ_ENABLED: "true",
      } as unknown as AppEnv["Bindings"],
      TELEGRAM,
      {
        resolvePersonalDelivery: async () => {
          throw databaseFailure;
        },
      },
    );

    const caught: unknown = await attempt.then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(caught).toBeInstanceOf(PersonalDeliveryAccountResolutionError);
    const error = caught as PersonalDeliveryAccountResolutionError;
    expect(error.name).toBe("PersonalDeliveryAccountResolutionError");
    expect(error.projectionFailure).toBe("status-502:TypeError");
    expect(error.cause).toBe(databaseFailure);
    expect(error.message).not.toContain("connection reset");
  });

  test("reports a tenant-safe failure name from the projection boundary", async () => {
    const memory = state();
    const object = new PersonalDeliveryProjection(memory.durableState, ENV, {
      resolvePersonalDelivery: async () => {
        throw new TypeError(
          "secret column list must never reach the connector",
        );
      },
    });

    const response = await object.fetch(request("/resolve", TELEGRAM));

    expect(response.status).toBe(502);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.failureName).toBe("TypeError");
    expect(JSON.stringify(body)).not.toContain("secret column list");
  });
});
