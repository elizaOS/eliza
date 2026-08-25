/**
 * Composes the real Telegram auth route with the real
 * OnboardingSessionCoordinator claim/complete/turn endpoints to prove that a
 * continuation attempt interrupted by a transient failure is resumable by the
 * identical signed retry — and only by it. The user store is mocked; the
 * Durable Object state machine and the route's mutation ordering run for real.
 */
import { describe, expect, mock, test } from "bun:test";
import * as provisioningObservation from "../../shared/src/lib/services/eliza-app/provisioning-observation";

const noProvisioning = {
  status: "none" as const,
  agentId: null,
  bridgeUrl: null,
  sandbox: null,
};

mock.module("../../shared/src/lib/cache/client", () => ({
  cache: {
    get: mock(async () => null),
    set: mock(async () => undefined),
  },
}));

mock.module("../../shared/src/lib/services/eliza-app/provisioning", () => ({
  ...provisioningObservation,
  getElizaAppProvisioningStatus: mock(async () => noProvisioning),
}));

const { OnboardingSessionCoordinator: CoordinatorValue } = await import(
  "../src/onboarding-session-coordinator"
);
const { handleTelegramAuth } = await import("../eliza-app/auth/telegram/route");
type TelegramAuthDependencies =
  import("../eliza-app/auth/telegram/route").TelegramAuthDependencies;

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

function createHarness() {
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
  return {
    objectByName,
    storageFor(name: string) {
      const storage = storageByName.get(name);
      if (!storage) throw new Error(`missing test storage for ${name}`);
      return storage;
    },
  };
}

type Harness = ReturnType<typeof createHarness>;

const TELEGRAM_ID = "123456789";
const PHONE = "+14155550123";
const USER = {
  id: "user-1",
  organization_id: "org-1",
  telegram_id: TELEGRAM_ID,
  telegram_username: "sam",
  phone_number: PHONE as string | null,
  name: "Sam",
  discord_id: null,
  whatsapp_id: null,
  organization: { id: "org-1", name: "Org 1" },
};

const AUTH_BODY = {
  phone_number: PHONE,
  id: 123456789,
  first_name: "Sam",
  username: "sam",
  auth_date: 1_786_224_000,
  hash: "a".repeat(64),
};

async function startBotSession(
  harness: Harness,
  sessionId: string,
): Promise<string> {
  const response = await harness.objectByName(sessionId).fetch(
    new Request("https://onboarding.test/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        input: {
          sessionId,
          message: "/start",
          platform: "telegram",
          platformUserId: TELEGRAM_ID,
          trustedPlatformIdentity: true,
          idempotencyKey: "telegram:start",
        },
      }),
    }),
  );
  const result = (await response.json()) as {
    session: { continuationToken?: string };
  };
  if (!result.session.continuationToken) {
    throw new Error("continuation token missing");
  }
  return result.session.continuationToken;
}

interface Instrumentation {
  claimIds: string[];
  redeemCalls: number;
  redeemSuccesses: number;
  completeCalls: number;
  linkIdentityCalls: number;
  findOrCreateCalls: number;
  createSessionCalls: number;
}

/**
 * Wires the route to the real Durable Objects the way the shared service
 * wrappers do (non-2xx becomes a thrown rejection), with hooks to inject a
 * transient failure into redemption or completion.
 */
function createDependencies(
  harness: Harness,
  options: {
    anonymous?: boolean;
    failRedemptionOnce?: boolean;
    failCompletionOnce?: boolean;
  },
): { dependencies: TelegramAuthDependencies; counts: Instrumentation } {
  const counts: Instrumentation = {
    claimIds: [],
    redeemCalls: 0,
    redeemSuccesses: 0,
    completeCalls: 0,
    linkIdentityCalls: 0,
    findOrCreateCalls: 0,
    createSessionCalls: 0,
  };
  let accountCreated = !options.anonymous;
  let redemptionFailuresLeft = options.failRedemptionOnce ? 1 : 0;
  let completionFailuresLeft = options.failCompletionOnce ? 1 : 0;

  const dependencies = {
    verifyAuth: () => true,
    validateAuthHeader: async () =>
      options.anonymous
        ? null
        : { userId: USER.id, organizationId: USER.organization.id },
    createSession: async () => {
      counts.createSessionCalls += 1;
      return {
        token: "integration-session-token",
        expiresAt: new Date("2026-08-09T00:00:00.000Z"),
      };
    },
    getById: async () => ({ ...USER }),
    getByIdForWrite: async () => ({ ...USER }),
    getByTelegramId: async () => (accountCreated ? { ...USER } : undefined),
    getByPhoneNumber: async () => (accountCreated ? { ...USER } : undefined),
    linkTelegramAndPhoneToUser: async () => {
      counts.linkIdentityCalls += 1;
      return { success: true };
    },
    findOrCreateByTelegramWithPhone: async () => {
      counts.findOrCreateCalls += 1;
      const isNew = !accountCreated;
      accountCreated = true;
      return {
        user: { ...USER },
        organization: { ...USER.organization },
        isNew,
      };
    },
    claimContinuation: async (input: {
      continuationToken: string;
      claimId: string;
      telegramId: string;
      phoneNumber: string;
      authenticatedAccount?: { userId: string; organizationId: string };
    }) => {
      counts.claimIds.push(input.claimId);
      const response = await harness
        .objectByName(input.continuationToken)
        .fetch(
          new Request("https://onboarding.internal/claim", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              claimId: input.claimId,
              telegramId: input.telegramId,
              phoneNumber: input.phoneNumber,
              userId: input.authenticatedAccount?.userId,
              organizationId: input.authenticatedAccount?.organizationId,
            }),
          }),
        );
      if (!response.ok) throw new Error(`claim rejected (${response.status})`);
      return (await response.json()) as never;
    },
    completeContinuationClaim: async (input: {
      continuationToken: string;
      claimId: string;
      telegramId: string;
      phoneNumber: string;
      userId: string;
      organizationId: string;
    }) => {
      counts.completeCalls += 1;
      if (completionFailuresLeft > 0) {
        completionFailuresLeft -= 1;
        throw new Error("simulated transient completion outage");
      }
      const response = await harness
        .objectByName(input.continuationToken)
        .fetch(
          new Request("https://onboarding.internal/complete-claim", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
          }),
        );
      if (!response.ok) {
        throw new Error(`completion rejected (${response.status})`);
      }
    },
    redeemContinuation: async (input: {
      sessionId: string;
      platform: string;
      continuationMode: string;
      authenticatedUser: {
        userId: string;
        organizationId: string;
        telegramId: string;
      };
      trustedPlatformIdentity: boolean;
      idempotencyKey: string;
    }) => {
      counts.redeemCalls += 1;
      if (redemptionFailuresLeft > 0) {
        redemptionFailuresLeft -= 1;
        throw new Error("simulated transient coordinator outage");
      }
      // Mirror runOnboardingChat: resolve the opaque token to its platform
      // session, then run the strict turn through the session Durable Object.
      const resolved = await harness.objectByName(input.sessionId).fetch(
        new Request("https://onboarding.internal/resolve", {
          method: "POST",
        }),
      );
      if (!resolved.ok) throw new Error("continuation resolution failed");
      const { sessionId } = (await resolved.json()) as { sessionId: string };
      const turn = await harness.objectByName(sessionId).fetch(
        new Request("https://onboarding.internal/turn", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId,
            input: { ...input, sessionId },
          }),
        }),
      );
      if (!turn.ok) throw new Error(`redemption turn failed (${turn.status})`);
      counts.redeemSuccesses += 1;
      return (await turn.json()) as never;
    },
  } as unknown as TelegramAuthDependencies;

  return { dependencies, counts };
}

function post(
  dependencies: TelegramAuthDependencies,
  token: string,
  options: { anonymous?: boolean } = {},
): Promise<Response> {
  return handleTelegramAuth(
    new Request("https://eliza.test/api/eliza-app/auth/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.anonymous
          ? {}
          : { authorization: "Bearer existing-session-token" }),
      },
      body: JSON.stringify({ ...AUTH_BODY, onboarding_session: token }),
    }),
    dependencies,
  );
}

describe("Telegram continuation retry integration (route + coordinator)", () => {
  test("a transient redemption failure is recoverable by the identical signed retry", async () => {
    const harness = createHarness();
    const token = await startBotSession(
      harness,
      `platform:telegram:${TELEGRAM_ID}`,
    );
    const { dependencies, counts } = createDependencies(harness, {
      failRedemptionOnce: true,
    });

    const attempt1 = await post(dependencies, token);
    expect(attempt1.status).toBe(503);
    expect(((await attempt1.json()) as { code?: string }).code).toBe(
      "ONBOARDING_CONTINUATION_FAILED",
    );

    const attempt2 = await post(dependencies, token);
    const redeemed = (await attempt2.json()) as {
      continuation_redeemed?: boolean;
      is_new_user?: boolean;
    };
    expect(attempt2.status).toBe(200);
    expect(redeemed.continuation_redeemed).toBe(true);

    // Redemption and completion each happened exactly once across the retry.
    expect(counts.claimIds).toHaveLength(2);
    expect(counts.claimIds[0]).toBe(counts.claimIds[1]);
    expect(counts.redeemCalls).toBe(2);
    expect(counts.redeemSuccesses).toBe(1);
    expect(counts.completeCalls).toBe(1);

    // A third identical call settles into a completed replay: no new link,
    // redemption, or completion work.
    const attempt3 = await post(dependencies, token);
    expect(attempt3.status).toBe(200);
    expect(
      ((await attempt3.json()) as { continuation_redeemed?: boolean })
        .continuation_redeemed,
    ).toBe(true);
    expect(counts.redeemSuccesses).toBe(1);
    expect(counts.completeCalls).toBe(1);
    expect(counts.linkIdentityCalls).toBe(2);
  });

  test("the anonymous create-then-retry transition resumes with a stable claim id", async () => {
    const harness = createHarness();
    const token = await startBotSession(
      harness,
      `platform:telegram:anon-${TELEGRAM_ID}`,
    );
    const { dependencies, counts } = createDependencies(harness, {
      anonymous: true,
      failRedemptionOnce: true,
    });

    const attempt1 = await post(dependencies, token, { anonymous: true });
    expect(attempt1.status).toBe(503);
    expect(counts.findOrCreateCalls).toBe(1);
    expect(counts.createSessionCalls).toBe(0);

    // The retry now resolves the account created by the first attempt, yet
    // hashes the same claim lineage and resumes it.
    const attempt2 = await post(dependencies, token, { anonymous: true });
    const redeemed = (await attempt2.json()) as {
      continuation_redeemed?: boolean;
    };
    expect(attempt2.status).toBe(200);
    expect(redeemed.continuation_redeemed).toBe(true);
    expect(counts.claimIds).toHaveLength(2);
    expect(counts.claimIds[0]).toBe(counts.claimIds[1]);
    expect(counts.redeemSuccesses).toBe(1);
    expect(counts.completeCalls).toBe(1);
    expect(counts.createSessionCalls).toBe(1);
  });

  test("a crash between redemption and completion resolves without re-redeeming", async () => {
    const harness = createHarness();
    const token = await startBotSession(
      harness,
      `platform:telegram:complete-${TELEGRAM_ID}`,
    );
    const { dependencies, counts } = createDependencies(harness, {
      failCompletionOnce: true,
    });

    const attempt1 = await post(dependencies, token);
    expect(attempt1.status).toBe(503);
    expect(counts.redeemSuccesses).toBe(1);
    expect(counts.completeCalls).toBe(1);

    // The session is already canonically bound; the retry must settle into a
    // completed replay, clear the stale claim, and never re-run redemption.
    const attempt2 = await post(dependencies, token);
    const replay = (await attempt2.json()) as {
      continuation_redeemed?: boolean;
      is_new_user?: boolean;
    };
    expect(attempt2.status).toBe(200);
    expect(replay.continuation_redeemed).toBe(true);
    expect(replay.is_new_user).toBe(false);
    expect(counts.redeemCalls).toBe(1);
    expect(counts.completeCalls).toBe(1);
    expect(counts.linkIdentityCalls).toBe(1);
    expect(
      await harness.storageFor(token).get("continuation-claim"),
    ).toBeUndefined();
  });
});
