/**
 * Exercises the real Durable Object owner across the anonymous/authenticated
 * scope split: a messaging turn files under the platform scope, an
 * authenticated continuation migrates the conversation to the account scope,
 * and the next messaging turn must still find it. The cache mirror is stubbed
 * to a permanent miss so the assertion is on durable state alone.
 */

import { describe, expect, mock, test } from "bun:test";
import type { OnboardingChatResult } from "@/lib/services/eliza-app/onboarding-chat";
import * as provisioningObservation from "../../shared/src/lib/services/eliza-app/provisioning-observation";
import type { OnboardingSessionCoordinator } from "../src/onboarding-session-coordinator";

const noProvisioning = {
  status: "none" as const,
  agentId: null,
  bridgeUrl: null,
  sandbox: null,
};

// The bridge under test must not depend on this: `cache.get` answers null for a
// cache outage and for a plain miss alike, so a session that only survives in
// the mirror is a session that disappears on the first bad minute.
mock.module("../../shared/src/lib/cache/client", () => ({
  cache: {
    get: mock(async () => null),
    set: mock(async () => undefined),
  },
}));

mock.module("../../shared/src/lib/services/eliza-app/user-service", () => ({
  elizaAppUserService: {
    findOrCreateByPhone: mock(async () => ({ success: true })),
    linkPhoneToUser: mock(async () => ({ success: true })),
    linkDiscordToUser: mock(async () => ({ success: true })),
    linkTelegramToUser: mock(async () => ({ success: true })),
  },
}));

mock.module("../../shared/src/lib/services/eliza-app/provisioning", () => ({
  ...provisioningObservation,
  getElizaAppProvisioningStatus: mock(async () => noProvisioning),
}));

const { OnboardingSessionCoordinator: OnboardingSessionCoordinatorValue } =
  await import("../src/onboarding-session-coordinator");

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

let harnessNumber = 0;

interface Harness {
  coordinator: OnboardingSessionCoordinator;
  storage: TestStorage;
  sessionId: string;
  telegramId: string;
}

function createHarness(): Harness {
  const telegramId = `70000000${++harnessNumber}`;
  const sessionId = `platform:telegram:${telegramId}`;
  const objects = new Map<string, OnboardingSessionCoordinator>();
  const storageByName = new Map<string, TestStorage>();
  const env: Record<string, unknown> = {};
  const objectByName = (name: string): OnboardingSessionCoordinator => {
    let object = objects.get(name);
    if (!object) {
      let storage = storageByName.get(name);
      if (!storage) {
        storage = new TestStorage();
        storageByName.set(name, storage);
      }
      object = new OnboardingSessionCoordinatorValue(
        { storage } as unknown as DurableObjectState,
        env as never,
      );
      objects.set(name, object);
    }
    return object;
  };
  // The continuation-token object lives in the same namespace, so the
  // coordinator must be able to address a sibling instance.
  env.ONBOARDING_SESSIONS = {
    getByName: (name: string) => ({
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        objectByName(name).fetch(new Request(input, init)),
    }),
  };
  const coordinator = objectByName(sessionId);
  const storage = storageByName.get(sessionId);
  if (!storage) throw new Error("missing test storage for the session object");
  return { coordinator, storage, sessionId, telegramId };
}

function telegramTurn(
  harness: Harness,
  message: string,
  idempotencyKey: string,
  authenticatedUser?: {
    userId: string;
    organizationId: string;
    telegramId: string;
  },
): Promise<Response> {
  return harness.coordinator.fetch(
    new Request("https://onboarding.test/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: harness.sessionId,
        input: {
          sessionId: harness.sessionId,
          message,
          platform: "telegram",
          platformUserId: harness.telegramId,
          trustedPlatformIdentity: true,
          idempotencyKey,
          authenticatedUser,
        },
      }),
    }),
  );
}

async function readResult(response: Response): Promise<OnboardingChatResult> {
  expect(response.status).toBe(200);
  return (await response.json()) as OnboardingChatResult;
}

function platformScopeKey(sessionId: string): string {
  return `session:platform:${encodeURIComponent(sessionId)}`;
}

function accountScopeKey(organizationId: string, userId: string): string {
  return `session:account:${encodeURIComponent(organizationId)}:${encodeURIComponent(userId)}`;
}

const account = {
  userId: "user-scope-alias",
  organizationId: "org-scope-alias",
};

describe("onboarding scope migration", () => {
  test("the messaging turn after sign-in resumes the account session instead of greeting again", async () => {
    const harness = createHarness();

    const first = await readResult(
      await telegramTurn(harness, "My name is Sam", "telegram:message-1"),
    );
    expect(first.requiresLogin).toBe(true);

    const authenticated = await readResult(
      await telegramTurn(harness, "signed in", "telegram:continuation", {
        ...account,
        telegramId: harness.telegramId,
      }),
    );
    expect(authenticated.requiresLogin).toBe(false);

    const afterLogin = await readResult(
      await telegramTurn(harness, "hey again", "telegram:message-2"),
    );

    expect(afterLogin.requiresLogin).toBe(false);
    expect(afterLogin.session.userId).toBe(account.userId);
    expect(afterLogin.session.organizationId).toBe(account.organizationId);
  });

  test("the migrated transcript keeps growing instead of restarting", async () => {
    const harness = createHarness();

    await telegramTurn(harness, "My name is Sam", "telegram:message-1");
    const authenticated = await readResult(
      await telegramTurn(harness, "signed in", "telegram:continuation", {
        ...account,
        telegramId: harness.telegramId,
      }),
    );
    const afterLogin = await readResult(
      await telegramTurn(harness, "hey again", "telegram:message-2"),
    );

    expect(afterLogin.session.id).toBe(authenticated.session.id);
    expect(afterLogin.session.history.length).toBeGreaterThan(
      authenticated.session.history.length,
    );
    expect(
      afterLogin.session.history.some(
        (message) => message.content === "My name is Sam",
      ),
    ).toBe(true);
  });

  test("the platform key holds a pointer to the account scope, not a session", async () => {
    const harness = createHarness();

    await telegramTurn(harness, "My name is Sam", "telegram:message-1");
    await telegramTurn(harness, "signed in", "telegram:continuation", {
      ...account,
      telegramId: harness.telegramId,
    });

    const platformRecord = await harness.storage.get<Record<string, unknown>>(
      platformScopeKey(harness.sessionId),
    );
    expect(platformRecord).toEqual({
      aliasScope: `account:${account.organizationId}:${account.userId}`,
    });

    const accountRecord = await harness.storage.get<Record<string, unknown>>(
      accountScopeKey(account.organizationId, account.userId),
    );
    expect(accountRecord?.userId).toBe(account.userId);

    const strandedPlatformHistory = await harness.storage.list({
      prefix: `history:platform:${encodeURIComponent(harness.sessionId)}:`,
    });
    expect(strandedPlatformHistory.size).toBe(0);
  });

  test("a legacy ledger migration leaves a durable platform pointer when the cache misses", async () => {
    const harness = createHarness();
    const first = await readResult(
      await telegramTurn(harness, "My name is Sam", "telegram:message-1"),
    );
    const platformScope = `platform:${encodeURIComponent(harness.sessionId)}`;

    await harness.storage.delete(platformScopeKey(harness.sessionId));
    await harness.storage.delete([
      ...(
        await harness.storage.list({ prefix: `history:${platformScope}:` })
      ).keys(),
    ]);
    await harness.storage.put("ledger", { session: first.session });

    const authenticated = await readResult(
      await telegramTurn(harness, "signed in", "telegram:continuation", {
        ...account,
        telegramId: harness.telegramId,
      }),
    );
    expect(authenticated.requiresLogin).toBe(false);
    expect(await harness.storage.get("ledger")).toBeUndefined();
    expect(
      await harness.storage.get<Record<string, unknown>>(
        platformScopeKey(harness.sessionId),
      ),
    ).toEqual({
      aliasScope: `account:${account.organizationId}:${account.userId}`,
    });

    const afterLogin = await readResult(
      await telegramTurn(harness, "hey again", "telegram:message-2"),
    );
    expect(afterLogin.requiresLogin).toBe(false);
    expect(afterLogin.session.id).toBe(authenticated.session.id);
    expect(afterLogin.session.userId).toBe(account.userId);
  });

  test("a second account never inherits the first account's transcript through the pointer", async () => {
    const harness = createHarness();

    await telegramTurn(harness, "My name is Sam", "telegram:message-1");
    await telegramTurn(harness, "signed in", "telegram:continuation", {
      ...account,
      telegramId: harness.telegramId,
    });

    const ownerRecordBefore = await harness.storage.get<
      Record<string, unknown>
    >(accountScopeKey(account.organizationId, account.userId));

    const intruder = await readResult(
      await telegramTurn(harness, "hello", "telegram:intruder", {
        userId: "user-other",
        organizationId: "org-other",
        telegramId: harness.telegramId,
      }),
    );

    expect(intruder.session.userId).toBe("user-other");
    expect(
      intruder.session.history.some(
        (message) => message.content === "My name is Sam",
      ),
    ).toBe(false);

    // The pointer is addressed by a public platform id. An authenticated turn
    // that followed it would read AND overwrite a scope it does not own.
    const ownerRecordAfter = await harness.storage.get<Record<string, unknown>>(
      accountScopeKey(account.organizationId, account.userId),
    );
    expect(ownerRecordAfter).toEqual(ownerRecordBefore);
    expect(ownerRecordAfter?.userId).toBe(account.userId);
  });
});
