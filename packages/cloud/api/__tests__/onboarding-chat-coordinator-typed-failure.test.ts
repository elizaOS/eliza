/**
 * Pins the onboarding chat route's typed rejections to the Worker deployment
 * shape, where every turn crosses a Durable Object stub before the route sees
 * its outcome.
 *
 * The route, the onboarding state machine and the OnboardingSessionCoordinator
 * all run for real over in-memory Durable Object storage; only provisioning,
 * the session cache and the user store are substituted. Without the coordinator
 * bound into the cloud-bindings context these assertions silently exercise the
 * local in-process path instead, which is the configuration the route's typed
 * branches were never proven in.
 */

import { describe, expect, mock, test } from "bun:test";
import { runWithCloudBindingsAsync } from "@/lib/runtime/cloud-bindings";

const noProvisioning = {
  status: "none" as const,
  agentId: null,
  bridgeUrl: null,
  sandbox: null,
};

mock.module("@/lib/cache/client", () => ({
  cache: {
    get: mock(async () => null),
    set: mock(async () => undefined),
  },
}));

mock.module("@/lib/services/eliza-app/provisioning", () => ({
  ensureElizaAppProvisioning: mock(async () => noProvisioning),
  getElizaAppProvisioningStatus: mock(async () => noProvisioning),
  publicElizaAppProvisioningPayload: (status: { status: string }) => ({
    status: status.status,
  }),
}));

mock.module("@/lib/services/eliza-app/user-service", () => ({
  elizaAppUserService: {
    findOrCreateByPhone: mock(async () => null),
    linkPhoneToUser: mock(async () => ({ success: true })),
    linkDiscordToUser: mock(async () => ({ success: true })),
    linkTelegramToUser: mock(async () => ({ success: true })),
  },
}));

const { OnboardingSessionCoordinator: CoordinatorValue } = await import(
  "../src/onboarding-session-coordinator"
);
const route = (await import("../eliza-app/onboarding/chat/route")).default;

class TestStorage {
  private readonly values = new Map<string, unknown>();
  private alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  async put(
    key: string | Record<string, unknown>,
    value?: unknown,
  ): Promise<void> {
    if (typeof key === "string") {
      this.values.set(key, structuredClone(value));
      return;
    }
    for (const [entryKey, entryValue] of Object.entries(key)) {
      this.values.set(entryKey, structuredClone(entryValue));
    }
  }

  async delete(key: string | string[]): Promise<boolean> {
    const keys = typeof key === "string" ? [key] : key;
    return keys.map((entry) => this.values.delete(entry)).some(Boolean);
  }

  async list<T>({
    prefix,
    startAfter,
    limit,
  }: {
    prefix: string;
    startAfter?: string;
    limit?: number;
  }): Promise<Map<string, T>> {
    return new Map(
      [...this.values.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .filter(([key]) => !startAfter || key > startAfter)
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, limit)
        .map(([key, value]) => [key, structuredClone(value) as T]),
    );
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(timestamp: number): Promise<void> {
    this.alarm = timestamp;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }

  async transaction<T>(
    operation: (transaction: TestStorage) => Promise<T>,
  ): Promise<T> {
    return operation(this);
  }
}

/**
 * One Durable Object namespace backed by real coordinator instances, exposed
 * both as the `ONBOARDING_SESSIONS` binding the shared service reads and as a
 * direct handle for asserting on the stub's own HTTP answer.
 */
function createCoordinatorNamespace() {
  const objects = new Map<string, InstanceType<typeof CoordinatorValue>>();
  const storageByName = new Map<string, TestStorage>();
  const env: Record<string, unknown> = {};
  const objectByName = (name: string) => {
    let object = objects.get(name);
    if (!object) {
      let storage = storageByName.get(name);
      if (!storage) {
        storage = new TestStorage();
        storageByName.set(name, storage);
      }
      object = new CoordinatorValue(
        { storage } as unknown as DurableObjectState,
        env as never,
      );
      objects.set(name, object);
    }
    return object;
  };
  env.ONBOARDING_SESSIONS = {
    getByName: (name: string) => ({
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        objectByName(name).fetch(new Request(input, init)),
    }),
  };
  return { env, objectByName };
}

const INTERNAL_SECRET = "internal-secret-for-test";

/** Posts to the real route with the coordinator bound, i.e. the Worker path. */
async function postViaCoordinator(
  env: Record<string, unknown>,
  body: Record<string, unknown>,
): Promise<Response> {
  return runWithCloudBindingsAsync(env, async () =>
    route.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      { INTERNAL_SECRET, ...env },
    ),
  );
}

describe("onboarding chat typed failures across the Durable Object boundary", () => {
  test("an unauthenticated confirmPlatformLink is refused 403, not a bare 500", async () => {
    const { env } = createCoordinatorNamespace();

    const response = await postViaCoordinator(env, {
      sessionId: crypto.randomUUID(),
      platform: "web",
      confirmPlatformLink: true,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      success: false,
      code: "access_denied",
    });
  });

  test("the same unauthenticated turn without confirmPlatformLink still succeeds", async () => {
    const { env } = createCoordinatorNamespace();

    const response = await postViaCoordinator(env, {
      sessionId: crypto.randomUUID(),
      platform: "web",
      message: "My name is Ada",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { requiresLogin: boolean };
    };
    expect(body.data.requiresLogin).toBe(true);
  });

  test("the coordinator's failure body carries the typed code and context", async () => {
    const { objectByName } = createCoordinatorNamespace();
    const sessionId = crypto.randomUUID();

    const response = await objectByName(sessionId).fetch(
      new Request("https://onboarding.test/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId,
          input: { sessionId, platform: "web", confirmPlatformLink: true },
        }),
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "ONBOARDING_TRUSTED_CONTINUATION_INVALID",
      context: { sessionFound: false },
    });
  });
});
