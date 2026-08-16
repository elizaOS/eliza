/**
 * Exercises the real in-process Personal Shared and identity-link Hono routes
 * under the authenticated Telegram edge request lifecycle.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { hasDbCacheContext } from "@/db/client";
import {
  getCloudBinding,
  hasCloudBindingsContext,
} from "@/lib/runtime/cloud-bindings";
import {
  getClientIp,
  getRequestIdempotencyKey,
} from "@/lib/runtime/request-context";
import { personalDeliveryProjectionObjectName } from "@/lib/services/eliza-app/personal-delivery-projection-contract";
import {
  getRuntimeR2Bucket,
  setRuntimeR2Bucket,
} from "@/lib/storage/r2-runtime-binding";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";
import { PersonalDeliveryProjection } from "../src/personal-delivery-projection";
import { PersonalTelegramDelivery } from "../src/personal-telegram-delivery";

const usersRepositoryModule = await import("@/db/repositories/users");
const identityLinkModule = await import(
  "@/lib/services/eliza-app/identity-link"
);
const personalSharedAgentModule = await import(
  "@/lib/services/shared-runtime/personal-shared-agent"
);
const resolveSharedAgentModule = await import(
  "@/lib/services/shared-runtime/resolve-shared-agent"
);
const sharedRestAdapterModule = await import(
  "@/lib/services/shared-runtime/shared-rest-adapter"
);

const TRACE_ID = "11111111-1111-4111-8111-111111111111";
const originalFetch = globalThis.fetch;
const HYPERDRIVE = { connectionString: "postgres://hyperdrive.internal/db" };
const BLOB = {
  async get() {
    return null;
  },
  async put() {},
  async delete() {},
};

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  alarmAt: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      let deleted = 0;
      for (const item of key) if (this.values.delete(item)) deleted += 1;
      return deleted;
    }
    return this.values.delete(key);
  }

  async list<T>(): Promise<Map<string, T>> {
    return new Map(this.values as Map<string, T>);
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  async setAlarm(timestamp: number): Promise<void> {
    this.alarmAt = timestamp;
  }
}

function deliveryNamespace(): AppEnv["Bindings"]["PERSONAL_TELEGRAM_DELIVERIES"] {
  const objects = new Map<string, PersonalTelegramDelivery>();
  return {
    getByName(name: string) {
      let object = objects.get(name);
      if (!object) {
        object = new PersonalTelegramDelivery(
          { storage: new MemoryStorage() } as unknown as DurableObjectState,
          {} as AppEnv["Bindings"],
        );
        objects.set(name, object);
      }
      return { fetch: (input, init) => object.fetch(new Request(input, init)) };
    },
  };
}

function telegramRequest(updateId: number, text: string): Request {
  return new Request("https://api-staging.eliza.app/", {
    method: "POST",
    headers: {
      "CF-Connecting-IP": "203.0.113.8",
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "webhook-secret",
    },
    body: JSON.stringify({
      update_id: updateId,
      message: {
        message_id: updateId - 80_000,
        from: { id: 123456, first_name: "Nubs" },
        chat: { id: 123456, type: "private" },
        text,
      },
    }),
  });
}

function executionContext(): ExecutionContext {
  return {
    passThroughOnException() {},
    waitUntil() {},
  } as unknown as ExecutionContext;
}

describe("Personal Telegram default local routes", () => {
  test("keeps bindings and DB scope through LINK invalidation and the next turn", async () => {
    let currentUser = "provisional-user";
    const projectionStorage = new MemoryStorage();
    let projection: PersonalDeliveryProjection | null = null;
    const projectionNames: string[] = [];
    const projectionNamespace = {
      getByName(name: string) {
        projectionNames.push(name);
        if (!projection) {
          projection = new PersonalDeliveryProjection(
            {
              storage: projectionStorage,
              id: { name },
            } as unknown as DurableObjectState,
            {
              BLOB,
              DATABASE_URL: "postgres://origin.invalid/db",
              HYPERDRIVE,
            } as unknown as AppEnv["Bindings"],
            {
              async resolvePersonalDelivery() {
                return {
                  userId: currentUser,
                  organizationId: `${currentUser}-org`,
                  dedicatedTarget: null,
                  isNew: false,
                  resolution: "single-query-repeat" as const,
                };
              },
              async revalidatePersonalDeliveryProjection() {
                return {
                  userId: currentUser,
                  organizationId: `${currentUser}-org`,
                  dedicatedTarget: null,
                  isNew: false,
                  resolution: "single-query-repeat" as const,
                };
              },
            },
          );
        }
        const object = projection;
        return {
          fetch(input: RequestInfo | URL, init?: RequestInit) {
            return object.fetch(new Request(input, init));
          },
        };
      },
    };
    const observedTurns: Array<{
      cloud: boolean;
      db: boolean;
      hyperdrive: unknown;
      idempotencyKey: string | undefined;
      clientIp: string | undefined;
      bucket: unknown;
      userId: string;
    }> = [];
    const observedLinks: Array<{ cloud: boolean; db: boolean }> = [];

    mock.module("@/lib/services/eliza-app/identity-link", () => ({
      ...identityLinkModule,
      async confirmIdentityLink(input: { platformId: string }) {
        observedLinks.push({
          cloud: hasCloudBindingsContext(),
          db: hasDbCacheContext(),
        });
        currentUser = "linked-user";
        const { invalidateBoundPersonalDeliveryProjection } = await import(
          "@/lib/services/eliza-app/personal-delivery-projection-contract"
        );
        await invalidateBoundPersonalDeliveryProjection(
          "telegram",
          input.platformId,
        );
        return {
          status: "linked" as const,
          userId: currentUser,
          organizationId: `${currentUser}-org`,
          platform: "telegram" as const,
        };
      },
    }));
    mock.module("@/db/repositories/users", () => ({
      ...usersRepositoryModule,
      providerForPlatform: () => "telegram",
    }));
    mock.module("@/lib/services/shared-runtime/personal-shared-agent", () => ({
      ...personalSharedAgentModule,
      personalSharedAgent: ({ userId }: { userId: string }) => ({
        id: `personal:${userId}`,
        agent_name: "Eliza",
      }),
    }));
    mock.module("@/lib/services/shared-runtime/resolve-shared-agent", () => ({
      ...resolveSharedAgentModule,
      resolveSharedRuntimeWorkerRequestContext: (c: AppContext) => ({
        executionCtx: c.executionCtx,
        namespace: {},
      }),
    }));
    mock.module("@/lib/services/shared-runtime/shared-rest-adapter", () => ({
      ...sharedRestAdapterModule,
      sharedRestMessageSend: async (agent: { id: string }) => {
        observedTurns.push({
          cloud: hasCloudBindingsContext(),
          db: hasDbCacheContext(),
          hyperdrive: getCloudBinding("HYPERDRIVE"),
          idempotencyKey: getRequestIdempotencyKey(),
          clientIp: getClientIp(),
          bucket: getRuntimeR2Bucket(),
          userId: agent.id,
        });
        return { text: `reply:${agent.id}` };
      },
    }));

    const { handlePersonalTelegramEdge } = await import(
      "../eliza-app/webhook/_telegram-edge"
    );
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("traceId", TRACE_ID);
      await next();
    });
    app.post("/", (c) => handlePersonalTelegramEdge(c as AppContext));
    app.onError(() => Response.json({ error: "failed" }, { status: 500 }));
    const env = {
      BLOB,
      DATABASE_URL: "postgres://origin.invalid/db",
      ELIZA_APP_TELEGRAM_BOT_TOKEN: "123456789:AAAAAAAAAAAAAAAAAAAA",
      ELIZA_APP_TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
      ELIZA_APP_WEBHOOK_PROJECT: "eliza-app",
      HYPERDRIVE,
      INTERNAL_SECRET: "outer-internal-secret",
      PERSONAL_DELIVERY_PROJECTION_READ_ENABLED: "true",
      PERSONAL_DELIVERY_PROJECTIONS: projectionNamespace,
      PERSONAL_TELEGRAM_DELIVERIES: deliveryNamespace(),
    } as AppEnv["Bindings"];
    const providerReplies: string[] = [];
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      if (body.text) providerReplies.push(body.text);
      return Response.json({
        ok: true,
        result: body.text ? { message_id: providerReplies.length } : true,
      });
    }) as unknown as typeof fetch;

    expect(
      (
        await app.fetch(
          telegramRequest(81_701, "before link"),
          env,
          executionContext(),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.fetch(
          telegramRequest(81_702, "LINK-7KQ2M4XW"),
          env,
          executionContext(),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.fetch(
          telegramRequest(81_703, "after link"),
          env,
          executionContext(),
        )
      ).status,
    ).toBe(200);

    expect(observedLinks).toEqual([{ cloud: true, db: true }]);
    expect(observedTurns.map((turn) => turn.userId)).toEqual([
      "personal:provisional-user",
      "personal:linked-user",
    ]);
    expect(observedTurns).toEqual([
      expect.objectContaining({
        cloud: true,
        db: true,
        hyperdrive: HYPERDRIVE,
        idempotencyKey: "telegram:eliza-app:81701",
        clientIp: "203.0.113.8",
        bucket: BLOB,
      }),
      expect.objectContaining({
        cloud: true,
        db: true,
        hyperdrive: HYPERDRIVE,
        idempotencyKey: "telegram:eliza-app:81703",
        clientIp: "203.0.113.8",
        bucket: BLOB,
      }),
    ]);
    expect(projectionNames).toEqual(
      Array.from({ length: 3 }, () =>
        personalDeliveryProjectionObjectName("telegram", "123456"),
      ),
    );
    expect(providerReplies).toEqual([
      "reply:personal:provisional-user",
      expect.stringContaining("You're linked!"),
      "reply:personal:linked-user",
    ]);
    expect(hasCloudBindingsContext()).toBe(false);
    expect(hasDbCacheContext()).toBe(false);
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setRuntimeR2Bucket(null);
  mock.restore();
});

afterAll(() => {
  mock.module("@/db/repositories/users", () => usersRepositoryModule);
  mock.module(
    "@/lib/services/eliza-app/identity-link",
    () => identityLinkModule,
  );
  mock.module(
    "@/lib/services/shared-runtime/personal-shared-agent",
    () => personalSharedAgentModule,
  );
  mock.module(
    "@/lib/services/shared-runtime/resolve-shared-agent",
    () => resolveSharedAgentModule,
  );
  mock.module(
    "@/lib/services/shared-runtime/shared-rest-adapter",
    () => sharedRestAdapterModule,
  );
});
