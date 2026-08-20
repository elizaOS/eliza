/**
 * Exercises the real onboarding state machine through its Durable Object
 * owner, including concurrent turn ordering and transport replay.
 */

import { describe, expect, mock, test } from "bun:test";
import type { OnboardingChatResult } from "@/lib/services/eliza-app/onboarding-chat";
import type { OnboardingSessionCoordinator } from "../src/onboarding-session-coordinator";

const noProvisioning = {
  status: "none" as const,
  agentId: null,
  bridgeUrl: null,
  sandbox: null,
};
let mirrorFailure: Error | undefined;

mock.module("../../shared/src/lib/cache/client", () => ({
  cache: {
    get: mock(async () => null),
    set: mock(async () => {
      if (mirrorFailure) throw mirrorFailure;
    }),
  },
}));

let provisioningFailure: Error | undefined;

mock.module("../../shared/src/lib/services/eliza-app/user-service", () => ({
  elizaAppUserService: {
    findOrCreateByPhone: mock(async () => ({ success: true })),
    linkPhoneToUser: mock(async () => ({ success: true })),
    linkDiscordToUser: mock(async () => ({ success: true })),
  },
}));

mock.module("../../shared/src/lib/services/eliza-app/provisioning", () => ({
  ensureElizaAppProvisioning: mock(async () => noProvisioning),
  // Onboarding no longer provisions compute; the read-only status poll is the
  // remaining fallible provisioning step inside an authenticated turn, so it
  // is where a pre-commit outage is injected.
  getElizaAppProvisioningStatus: mock(async () => {
    if (provisioningFailure) throw provisioningFailure;
    return noProvisioning;
  }),
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

function createCoordinatorHarness(): {
  coordinator: OnboardingSessionCoordinator;
  objectByName(name: string): OnboardingSessionCoordinator;
  restart(name: string): OnboardingSessionCoordinator;
  sessionId: string;
  storageFor(name: string): TestStorage;
} {
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
  env.ONBOARDING_SESSIONS = {
    getByName: (name: string) => ({
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        objectByName(name).fetch(new Request(input, init)),
    }),
  };
  const sessionId = `platform:discord:user-${++harnessNumber}`;
  return {
    coordinator: objectByName(sessionId),
    objectByName,
    restart(name: string) {
      objects.delete(name);
      return objectByName(name);
    },
    storageFor(name: string) {
      const storage = storageByName.get(name);
      if (!storage) throw new Error(`missing test storage for ${name}`);
      return storage;
    },
    sessionId,
  };
}

function turn(
  coordinator: OnboardingSessionCoordinator,
  sessionId: string,
  message: string,
  idempotencyKey: string,
  authenticatedUser?: {
    userId: string;
    organizationId: string;
    discordId?: string;
  },
): Promise<Response> {
  return coordinator.fetch(
    new Request("https://onboarding.test/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        input: {
          sessionId,
          message,
          platform: "discord",
          platformUserId: sessionId.slice("platform:discord:".length),
          trustedPlatformIdentity: true,
          idempotencyKey,
          authenticatedUser,
        },
      }),
    }),
  );
}

function browserDiscordTurn(
  coordinator: OnboardingSessionCoordinator,
  sessionId: string,
  message: string,
  idempotencyKey: string,
  discordId: string,
): Promise<Response> {
  return coordinator.fetch(
    new Request("https://onboarding.test/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        input: {
          sessionId,
          message,
          platform: "web",
          trustedPlatformIdentity: false,
          idempotencyKey,
          authenticatedUser: {
            userId: "user-a",
            organizationId: "org-a",
            discordId,
          },
        },
      }),
    }),
  );
}

async function readResult(response: Response): Promise<OnboardingChatResult> {
  return (await response.json()) as OnboardingChatResult;
}

function telegramTurn(
  coordinator: OnboardingSessionCoordinator,
  sessionId: string,
  authenticatedUser?: {
    userId: string;
    organizationId: string;
    telegramId: string;
  },
): Promise<Response> {
  const telegramId = "123456789";
  return coordinator.fetch(
    new Request("https://onboarding.test/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        input: {
          sessionId,
          message: "/start",
          platform: "telegram",
          platformUserId: telegramId,
          trustedPlatformIdentity: true,
          idempotencyKey: authenticatedUser
            ? "telegram:authenticated"
            : "telegram:start",
          authenticatedUser,
        },
      }),
    }),
  );
}

function telegramStatusOnlyTurn(
  coordinator: OnboardingSessionCoordinator,
  sessionId: string,
): Promise<Response> {
  return coordinator.fetch(
    new Request("https://onboarding.test/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        input: {
          sessionId,
          platform: "telegram",
          platformUserId: "123456789",
          platformDisplayName: "Nubs",
          trustedPlatformIdentity: true,
          statusOnly: true,
          idempotencyKey: "telegram-account-claim:delivery-1",
          authenticatedUser: {
            userId: "user-a",
            organizationId: "org-a",
            telegramId: "123456789",
          },
        },
      }),
    }),
  );
}

describe("OnboardingSessionCoordinator", () => {
  test("keeps a fresh idempotent status poll read-only without a replay marker", async () => {
    const harness = createCoordinatorHarness();
    const sessionId = `platform:telegram-claim:${"a".repeat(64)}`;
    const coordinator = harness.objectByName(sessionId);

    const firstResponse = await telegramStatusOnlyTurn(coordinator, sessionId);
    expect(firstResponse.status).toBe(200);
    const first = await readResult(firstResponse);
    expect(first.session).toMatchObject({
      id: sessionId,
      userId: "user-a",
      organizationId: "org-a",
      history: [],
    });
    expect(first.session.continuationToken).toEqual(expect.any(String));
    expect(
      (await harness.storageFor(sessionId).list({ prefix: "replay:" })).size,
    ).toBe(0);

    const repeatedResponse = await telegramStatusOnlyTurn(
      coordinator,
      sessionId,
    );
    expect(repeatedResponse.status).toBe(200);
    const repeated = await readResult(repeatedResponse);
    expect(repeated.session.id).toBe(first.session.id);
    expect(repeated.session.continuationToken).toBe(
      first.session.continuationToken,
    );
    expect(repeated.session.history).toEqual([]);
    expect(
      (await harness.storageFor(sessionId).list({ prefix: "replay:" })).size,
    ).toBe(0);
  });

  test("keeps a trusted platform session after a rejected account adoption", async () => {
    const harness = createCoordinatorHarness();
    await turn(
      harness.coordinator,
      harness.sessionId,
      "My name is Sam",
      "discord:message-1",
    );
    const scope = `platform:${encodeURIComponent(harness.sessionId)}`;
    const storage = harness.storageFor(harness.sessionId);
    const storedSession = await storage.get<Record<string, unknown>>(
      `session:${scope}`,
    );
    if (!storedSession) throw new Error("platform session was not stored");
    await storage.put(`session:${scope}`, {
      ...storedSession,
      userId: "user-a",
      organizationId: "org-a",
    });
    await turn(
      harness.coordinator,
      harness.sessionId,
      "Account B",
      "discord:message-2",
      { userId: "user-b", organizationId: "org-b" },
    );

    const resumed = await readResult(
      await turn(
        harness.coordinator,
        harness.sessionId,
        "Still here",
        "discord:message-3",
      ),
    );
    expect(resumed.session.history.map((message) => message.content)).toEqual(
      expect.arrayContaining(["My name is Sam", "Still here"]),
    );
  });

  test("retains an accepted delivery beyond the former replay window", async () => {
    const { coordinator, sessionId, storageFor } = createCoordinatorHarness();
    let first: OnboardingChatResult | undefined;

    for (let index = 0; index < 65; index += 1) {
      const response = await turn(
        coordinator,
        sessionId,
        `turn ${index}`,
        `discord:message-${index}`,
      );
      expect(response.status).toBe(200);
      if (index === 0) first = await readResult(response);
    }

    if (!first) throw new Error("first delivery was not recorded");
    const scope = `platform:${encodeURIComponent(sessionId)}`;
    const storedSession = await storageFor(sessionId).get<{
      historyChunkCount: number;
    }>(`session:${scope}`);
    expect(storedSession?.historyChunkCount).toBe(13);
    expect(
      await storageFor(sessionId).get<unknown[]>(`history:${scope}:0`),
    ).toHaveLength(10);
    const replay = await readResult(
      await turn(
        coordinator,
        sessionId,
        "must not execute",
        "discord:message-0",
      ),
    );
    expect(replay.reply).toBe(first.reply);
    expect(replay.session).toEqual(first.session);
  });

  test("replays a delivery after the Durable Object restarts", async () => {
    const harness = createCoordinatorHarness();
    const first = await readResult(
      await turn(
        harness.coordinator,
        harness.sessionId,
        "My name is Sam",
        "discord:message-1",
      ),
    );

    const restarted = harness.restart(harness.sessionId);
    const replay = await readResult(
      await turn(
        restarted,
        harness.sessionId,
        "must not execute",
        "discord:message-1",
      ),
    );

    expect(replay.reply).toBe(first.reply);
    expect(replay.session).toEqual(first.session);
  });

  test("executes a duplicate again after its explicit replay expiry", async () => {
    const harness = createCoordinatorHarness();
    await turn(
      harness.coordinator,
      harness.sessionId,
      "My name is Sam",
      "discord:message-1",
    );
    const scope = `platform:${encodeURIComponent(harness.sessionId)}`;
    const replayKey = `replay:${scope}:${encodeURIComponent(
      "standard:no-telegram:no-discord:discord:message-1",
    )}`;
    const storage = harness.storageFor(harness.sessionId);
    const stored = await storage.get<{ expiresAt: number }>(replayKey);
    if (!stored) throw new Error("replay entry was not stored");
    await storage.put(replayKey, { ...stored, expiresAt: Date.now() - 1 });

    const retried = await readResult(
      await turn(
        harness.coordinator,
        harness.sessionId,
        "Tell me more",
        "discord:message-1",
      ),
    );

    expect(retried.session.history.map((message) => message.content)).toEqual(
      expect.arrayContaining(["My name is Sam", "Tell me more"]),
    );
  });

  test("removes expired replay entries when its alarm fires", async () => {
    const harness = createCoordinatorHarness();
    await turn(
      harness.coordinator,
      harness.sessionId,
      "My name is Sam",
      "discord:message-1",
    );
    const scope = `platform:${encodeURIComponent(harness.sessionId)}`;
    const replayKey = `replay:${scope}:${encodeURIComponent(
      "standard:no-telegram:no-discord:discord:message-1",
    )}`;
    const storage = harness.storageFor(harness.sessionId);
    const stored = await storage.get<{ expiresAt: number }>(replayKey);
    if (!stored) throw new Error("replay entry was not stored");
    await storage.put(replayKey, { ...stored, expiresAt: Date.now() - 1 });

    await harness.coordinator.alarm();

    expect(await storage.get(replayKey)).toBeUndefined();
    expect(await storage.getAlarm()).toBeNull();
  });

  test("sweeps replay expiry in bounded resumable batches", async () => {
    const harness = createCoordinatorHarness();
    const storage = harness.storageFor(harness.sessionId);
    const now = Date.now();
    const futureExpiry = now + 60_000;

    for (let index = 0; index < 129; index += 1) {
      await storage.put(
        `replay:platform:test:expired-${String(index).padStart(3, "0")}`,
        {
          expiresAt: now - 1,
        },
      );
    }
    await storage.put("replay:platform:test:future", {
      expiresAt: futureExpiry,
    });

    await harness.coordinator.alarm();

    expect(
      await storage.list({ prefix: "replay:platform:test:" }),
    ).toHaveLength(2);
    expect(await storage.getAlarm()).toBeGreaterThanOrEqual(now);
    expect(
      await storage.get<{ startAfter: string }>("replay-cleanup-state"),
    ).toEqual(expect.objectContaining({ startAfter: expect.any(String) }));

    await harness.coordinator.alarm();

    expect(await storage.list({ prefix: "replay:platform:test:" })).toEqual(
      new Map([["replay:platform:test:future", { expiresAt: futureExpiry }]]),
    );
    expect(await storage.get("replay-cleanup-state")).toBeUndefined();
    expect(await storage.getAlarm()).toBe(futureExpiry);
  });

  test("fails instead of silently dropping a missing history chunk", async () => {
    const harness = createCoordinatorHarness();
    for (let index = 0; index < 6; index += 1) {
      await turn(
        harness.coordinator,
        harness.sessionId,
        `turn ${index}`,
        `discord:message-${index}`,
      );
    }
    const scope = `platform:${encodeURIComponent(harness.sessionId)}`;
    await harness.storageFor(harness.sessionId).delete(`history:${scope}:1`);

    const response = await turn(
      harness.coordinator,
      harness.sessionId,
      "must fail",
      "discord:message-missing-history",
    );

    expect(response.status).toBe(500);
    expect((await response.json()) as unknown).toEqual({
      error: `onboarding session history is incomplete for ${scope}`,
    });
  });

  test("returns the persisted result when cache mirroring fails", async () => {
    const harness = createCoordinatorHarness();
    mirrorFailure = new Error("cache unavailable");
    try {
      const response = await turn(
        harness.coordinator,
        harness.sessionId,
        "My name is Sam",
        "discord:message-1",
      );
      expect(response.status).toBe(200);
      const restarted = harness.restart(harness.sessionId);
      const replay = await turn(
        restarted,
        harness.sessionId,
        "must not execute",
        "discord:message-1",
      );
      expect(replay.status).toBe(200);
    } finally {
      mirrorFailure = undefined;
    }
  });

  test("keeps identical delivery ids isolated by authenticated account", async () => {
    const harness = createCoordinatorHarness();
    const first = await readResult(
      await turn(
        harness.coordinator,
        harness.sessionId,
        "Hello from account A",
        "discord:message-1",
        { userId: "user-a", organizationId: "org-a" },
      ),
    );
    const second = await readResult(
      await turn(
        harness.coordinator,
        harness.sessionId,
        "Hello from account B",
        "discord:message-1",
        { userId: "user-b", organizationId: "org-b" },
      ),
    );

    expect(second.session.userId).toBe("user-b");
    expect(second.session.organizationId).toBe("org-b");
    expect(
      second.session.history.map((message) => message.content),
    ).not.toContain("Hello from account A");
    const storage = harness.storageFor(harness.sessionId);
    const accountAScope = "account:org-a:user-a";
    const accountBScope = "account:org-b:user-b";
    expect(
      await storage.get<{ userId: string }>(`session:${accountAScope}`),
    ).toMatchObject({ userId: "user-a" });
    expect(
      await storage.get<{ userId: string }>(`session:${accountBScope}`),
    ).toMatchObject({ userId: "user-b" });
    expect(
      await storage.get(
        `replay:${accountAScope}:${encodeURIComponent("standard:no-telegram:no-discord:discord:message-1")}`,
      ),
    ).toBeDefined();
    expect(
      await storage.get(
        `replay:${accountBScope}:${encodeURIComponent("standard:no-telegram:no-discord:discord:message-1")}`,
      ),
    ).toBeDefined();

    const replay = await readResult(
      await turn(
        harness.coordinator,
        harness.sessionId,
        "must not execute",
        "discord:message-1",
        { userId: "user-a", organizationId: "org-a" },
      ),
    );
    expect(replay).toEqual(first);
  });

  test("never replays an accepted browser turn across signed Discord identities", async () => {
    const harness = createCoordinatorHarness();
    await turn(
      harness.coordinator,
      harness.sessionId,
      "My name is Sam",
      "discord:message-1",
    );
    const platformUserId = harness.sessionId.slice("platform:discord:".length);
    const accepted = await browserDiscordTurn(
      harness.coordinator,
      harness.sessionId,
      "Continue",
      "browser:continue",
      platformUserId,
    );
    expect(accepted.status).toBe(200);

    const mismatch = await browserDiscordTurn(
      harness.coordinator,
      harness.sessionId,
      "must not replay",
      "browser:continue",
      "different-discord-user",
    );
    expect(mismatch.status).toBe(500);
    expect((await mismatch.json()) as unknown).toEqual({
      error:
        "The authenticated messaging identity does not match this onboarding session",
      code: "ONBOARDING_PLATFORM_IDENTITY_MISMATCH",
      context: {
        platform: "discord",
        hasSignedPlatformIdentity: true,
      },
    });
  });

  test("inspects the exact session before and after account-scope migration", async () => {
    const harness = createCoordinatorHarness();
    const first = await readResult(
      await turn(
        harness.coordinator,
        harness.sessionId,
        "My name is Sam",
        "discord:message-1",
      ),
    );

    const inspect = () =>
      harness.coordinator.fetch(
        new Request("https://onboarding.test/inspect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: harness.sessionId }),
        }),
      );

    const before = await inspect();
    expect(before.status).toBe(200);
    expect((await before.json()) as unknown).toMatchObject({
      id: harness.sessionId,
      platform: "discord",
      platformIdentityTrusted: true,
    });

    await turn(
      harness.coordinator,
      harness.sessionId,
      "Continue",
      "discord:message-2",
      { userId: "user-a", organizationId: "org-a" },
    );
    const after = await inspect();
    expect(after.status).toBe(200);
    expect((await after.json()) as unknown).toMatchObject({
      id: first.session.id,
      userId: "user-a",
      organizationId: "org-a",
    });
  });

  test("claims a Telegram continuation before mutation and rejects a concurrent claimant", async () => {
    const harness = createCoordinatorHarness();
    const telegramSessionId = `platform:telegram:${harnessNumber}`;
    const first = await readResult(
      await telegramTurn(
        harness.objectByName(telegramSessionId),
        telegramSessionId,
      ),
    );
    const token = first.session.continuationToken;
    if (!token) throw new Error("Telegram continuation token missing");
    const tokenObject = harness.objectByName(token);
    const claim = (claimId: string) =>
      tokenObject.fetch(
        new Request("https://onboarding.test/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            claimId,
            telegramId: "123456789",
            phoneNumber: "+14155550123",
          }),
        }),
      );

    const acquired = await claim("claim-a");
    expect(acquired.status).toBe(200);
    expect((await acquired.json()) as unknown).toMatchObject({
      status: "acquired",
      sessionId: telegramSessionId,
    });
    const concurrent = await claim("claim-b");
    expect(concurrent.status).toBe(409);

    // The exact holder resumes its own claim after a transient failure; a
    // competing claim id never does.
    const resumed = await claim("claim-a");
    expect(resumed.status).toBe(200);
    expect((await resumed.json()) as unknown).toMatchObject({
      status: "acquired",
      sessionId: telegramSessionId,
    });
  });

  test("elapsed time never lets a competing claimant take over; the exact holder resumes", async () => {
    const harness = createCoordinatorHarness();
    const telegramSessionId = `platform:telegram:lease-${harnessNumber}`;
    const first = await readResult(
      await telegramTurn(
        harness.objectByName(telegramSessionId),
        telegramSessionId,
      ),
    );
    const token = first.session.continuationToken;
    if (!token) throw new Error("Telegram continuation token missing");
    const tokenObject = harness.objectByName(token);
    const claim = (body: Record<string, unknown>) =>
      tokenObject.fetch(
        new Request("https://onboarding.test/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            claimId: "claim-a",
            telegramId: "123456789",
            phoneNumber: "+14155550123",
            userId: "user-a",
            organizationId: "org-a",
            ...body,
          }),
        }),
      );
    expect((await claim({})).status).toBe(200);
    const storage = harness.storageFor(token);
    const stored =
      await storage.get<Record<string, unknown>>("continuation-claim");
    if (!stored) throw new Error("continuation claim missing");
    // Legacy claim records carried an expiresAt lease. Age one far into the
    // past to prove elapsed time grants a competitor nothing and costs the
    // holder nothing.
    await storage.put("continuation-claim", {
      ...stored,
      expiresAt: Date.now() - 1,
    });

    expect(
      (
        await claim({
          claimId: "claim-b",
          phoneNumber: "+14155550124",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await claim({
          claimId: "claim-b",
          userId: "user-b",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await claim({
          claimId: "claim-b",
          userId: undefined,
          organizationId: undefined,
        })
      ).status,
    ).toBe(409);
    expect((await claim({ claimId: "claim-b" })).status).toBe(409);

    // The exact holder — same claim id, same bindings — resumes.
    const resumed = await claim({ claimId: "claim-a" });
    expect(resumed.status).toBe(200);
    expect((await resumed.json()) as unknown).toMatchObject({
      status: "acquired",
    });
  });

  test("completes a claimed continuation only after the canonical session is bound", async () => {
    const harness = createCoordinatorHarness();
    const telegramSessionId = `platform:telegram:complete-${harnessNumber}`;
    const coordinator = harness.objectByName(telegramSessionId);
    const first = await readResult(
      await telegramTurn(coordinator, telegramSessionId),
    );
    const token = first.session.continuationToken;
    if (!token) throw new Error("Telegram continuation token missing");
    const tokenObject = harness.objectByName(token);
    const claimBody = {
      claimId: "claim-complete",
      telegramId: "123456789",
      phoneNumber: "+14155550123",
      userId: "user-a",
      organizationId: "org-a",
    };
    const acquired = await tokenObject.fetch(
      new Request("https://onboarding.test/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(claimBody),
      }),
    );
    expect(acquired.status).toBe(200);
    const beforeBinding = await tokenObject.fetch(
      new Request("https://onboarding.test/complete-claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(claimBody),
      }),
    );
    expect(beforeBinding.status).toBe(409);

    await telegramTurn(coordinator, telegramSessionId, {
      userId: "user-a",
      organizationId: "org-a",
      telegramId: "123456789",
    });
    const competingClaim = await tokenObject.fetch(
      new Request("https://onboarding.test/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...claimBody, claimId: "claim-competing" }),
      }),
    );
    expect(competingClaim.status).toBe(409);
    const wrongPhone = await tokenObject.fetch(
      new Request("https://onboarding.test/complete-claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...claimBody,
          phoneNumber: "+14155550124",
        }),
      }),
    );
    expect(wrongPhone.status).toBe(409);
    const completed = await tokenObject.fetch(
      new Request("https://onboarding.test/complete-claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(claimBody),
      }),
    );
    expect(completed.status).toBe(200);
    const replay = await tokenObject.fetch(
      new Request("https://onboarding.test/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...claimBody, claimId: "claim-replay" }),
      }),
    );
    expect(replay.status).toBe(200);
    expect((await replay.json()) as unknown).toMatchObject({
      status: "completed",
      userId: "user-a",
      organizationId: "org-a",
    });
  });

  test("treats an account-bound Telegram continuation as completed only for the same identity", async () => {
    const harness = createCoordinatorHarness();
    const telegramSessionId = `platform:telegram:bound-${harnessNumber}`;
    const coordinator = harness.objectByName(telegramSessionId);
    const first = await readResult(
      await telegramTurn(coordinator, telegramSessionId),
    );
    const token = first.session.continuationToken;
    if (!token) throw new Error("Telegram continuation token missing");
    await telegramTurn(coordinator, telegramSessionId, {
      userId: "user-a",
      organizationId: "org-a",
      telegramId: "123456789",
    });
    const tokenObject = harness.objectByName(token);
    const claim = (telegramId: string, userId: string) =>
      tokenObject.fetch(
        new Request("https://onboarding.test/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            claimId: "claim-bound",
            telegramId,
            phoneNumber: "+14155550123",
            userId,
            organizationId: "org-a",
          }),
        }),
      );

    const completed = await claim("123456789", "user-a");
    expect(completed.status).toBe(200);
    expect((await completed.json()) as unknown).toMatchObject({
      status: "completed",
      userId: "user-a",
      organizationId: "org-a",
    });
    expect((await claim("999999999", "user-a")).status).toBe(403);
    expect((await claim("123456789", "user-b")).status).toBe(403);
  });

  test("serializes concurrent turns and replays a delivery exactly once", async () => {
    const harness = createCoordinatorHarness();
    const { coordinator, sessionId } = harness;
    const [firstResponse, secondResponse] = await Promise.all([
      turn(coordinator, sessionId, "My name is Sam", "discord:message-1"),
      turn(coordinator, sessionId, "Tell me more", "discord:message-2"),
    ]);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    const first = await readResult(firstResponse);
    const second = await readResult(secondResponse);
    expect(first.session.history).toHaveLength(2);
    expect(second.session.history).toHaveLength(4);
    expect(
      second.session.history.map(
        (message: { content: string }) => message.content,
      ),
    ).toEqual(expect.arrayContaining(["My name is Sam", "Tell me more"]));
    const continuationToken = first.session.continuationToken;
    if (!continuationToken)
      throw new Error("platform session has no continuation token");
    const continuation = await harness
      .objectByName(continuationToken)
      .fetch(
        new Request("https://onboarding.test/resolve", { method: "POST" }),
      );
    expect((await continuation.json()) as unknown).toEqual({
      sessionId,
    });

    const replayResponse = await turn(
      coordinator,
      sessionId,
      "this changed payload must not execute",
      "discord:message-1",
    );
    expect(replayResponse.status).toBe(200);
    const replay = await readResult(replayResponse);
    expect(replay.reply).toBe(first.reply);
    expect(replay.session).toEqual(first.session);

    const thirdResponse = await turn(
      coordinator,
      sessionId,
      "Third turn",
      "discord:message-3",
    );
    const third = await readResult(thirdResponse);
    expect(third.session.history).toHaveLength(6);
    expect(
      third.session.history.filter(
        (message: { content: string }) => message.content === "My name is Sam",
      ),
    ).toHaveLength(1);
    expect(
      third.session.history.some(
        (message: { content: string }) =>
          message.content === "this changed payload must not execute",
      ),
    ).toBe(false);
  });

  describe("proactive greeting queue", () => {
    const QUEUE = "proactive-greetings:discord";

    function greeting(sessionId: string, overrides?: Record<string, unknown>) {
      return {
        sessionId,
        platformUserId: sessionId.slice("platform:discord:".length) || "u",
        message: "you're all set",
        createdAt: new Date().toISOString(),
        deliveryNonce: `nonce-${sessionId.replaceAll(/[^A-Za-z0-9_-]/g, "").slice(-12)}`,
        ...overrides,
      };
    }

    function enqueue(
      coordinator: OnboardingSessionCoordinator,
      body: unknown,
    ): Promise<Response> {
      return coordinator.fetch(
        new Request("https://onboarding.test/enqueue-greeting", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    }

    function drain(
      coordinator: OnboardingSessionCoordinator,
      limit?: number,
      platformUserId?: string,
    ): Promise<Response> {
      return coordinator.fetch(
        new Request("https://onboarding.test/drain-greetings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(limit === undefined ? {} : { limit }),
            ...(platformUserId ? { platformUserId } : {}),
          }),
        }),
      );
    }

    function acknowledge(
      coordinator: OnboardingSessionCoordinator,
      acknowledgements: Array<{ sessionId: string; leaseId: string }>,
      platformUserId?: string,
    ): Promise<Response> {
      return coordinator.fetch(
        new Request("https://onboarding.test/ack-greetings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            acknowledgements,
            ...(platformUserId ? { platformUserId } : {}),
          }),
        }),
      );
    }

    async function greetingsOf(
      response: Response,
    ): Promise<Array<{ sessionId: string; leaseId: string }>> {
      const body = (await response.json()) as {
        greetings: Array<{ sessionId: string; leaseId: string }>;
      };
      return body.greetings;
    }

    test("a live lease hides greetings until matching acknowledgement", async () => {
      const harness = createCoordinatorHarness();
      const queue = harness.objectByName(QUEUE);

      expect(
        (await enqueue(queue, greeting("platform:discord:greet-1"))).status,
      ).toBe(200);
      expect(
        (await enqueue(queue, greeting("platform:discord:greet-2"))).status,
      ).toBe(200);

      const first = await greetingsOf(await drain(queue));
      expect(first.map((entry) => entry.sessionId).sort()).toEqual([
        "platform:discord:greet-1",
        "platform:discord:greet-2",
      ]);

      // A concurrent poll cannot claim an actively leased entry.
      expect(await greetingsOf(await drain(queue))).toEqual([]);

      const wrongAck = await acknowledge(queue, [
        { sessionId: first[0]?.sessionId ?? "", leaseId: "wrong-lease" },
      ]);
      expect((await wrongAck.json()) as unknown).toEqual({ acknowledged: 0 });
      expect(await greetingsOf(await drain(queue))).toEqual([]);

      const ackResponse = await acknowledge(
        queue,
        first.map(({ sessionId, leaseId }) => ({ sessionId, leaseId })),
      );
      expect((await ackResponse.json()) as unknown).toEqual({
        acknowledged: 2,
      });
      expect(await greetingsOf(await drain(queue))).toEqual([]);
    });

    test("an explicit lifecycle expiry survives beyond the short onboarding TTL", async () => {
      const harness = createCoordinatorHarness();
      const queue = harness.objectByName(QUEUE);
      const createdAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      expect(
        (
          await enqueue(
            queue,
            greeting("lifecycle:workspace-ready", { createdAt, expiresAt }),
          )
        ).status,
      ).toBe(200);
      expect(await greetingsOf(await drain(queue))).toHaveLength(1);
    });

    test("an acknowledged lifecycle event cannot be re-enqueued before its expiry", async () => {
      const harness = createCoordinatorHarness();
      const queue = harness.objectByName(QUEUE);
      const entry = greeting("lifecycle:stable-event", {
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      });

      await enqueue(queue, entry);
      const [claimed] = await greetingsOf(await drain(queue));
      expect(claimed).toBeDefined();
      const acknowledged = await acknowledge(queue, [
        { sessionId: claimed!.sessionId, leaseId: claimed!.leaseId },
      ]);
      expect((await acknowledged.json()) as unknown).toEqual({
        acknowledged: 1,
      });

      await enqueue(queue, entry);
      expect(await greetingsOf(await drain(queue))).toEqual([]);
    });

    test("an unacknowledged greeting is reclaimable after lease expiry", async () => {
      const harness = createCoordinatorHarness();
      const queue = harness.objectByName(QUEUE);
      const sessionId = "platform:discord:recover";
      await enqueue(queue, greeting(sessionId));

      const first = await greetingsOf(await drain(queue));
      expect(first).toHaveLength(1);

      const storage = harness.storageFor(QUEUE);
      const key = `greeting:${encodeURIComponent(sessionId)}`;
      const stored = await storage.get<Record<string, unknown>>(key);
      if (!stored) throw new Error("leased greeting was not stored");
      await storage.put(key, {
        ...stored,
        lease: { id: first[0]?.leaseId, expiresAt: Date.now() - 1 },
      });

      const reclaimed = await greetingsOf(await drain(queue));
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0]?.sessionId).toBe(sessionId);
      expect(reclaimed[0]?.leaseId).not.toBe(first[0]?.leaseId);

      // A delayed acknowledgement from the old delivery cannot delete the
      // newly leased entry.
      const staleAck = await acknowledge(queue, [
        { sessionId, leaseId: first[0]?.leaseId ?? "" },
      ]);
      expect((await staleAck.json()) as unknown).toEqual({ acknowledged: 0 });
      expect(await greetingsOf(await drain(queue))).toEqual([]);

      const currentAck = await acknowledge(queue, [
        { sessionId, leaseId: reclaimed[0]?.leaseId ?? "" },
      ]);
      expect((await currentAck.json()) as unknown).toEqual({ acknowledged: 1 });
    });

    test("one recipient claim reaches a legacy lifecycle notice beyond 128 unrelated rows", async () => {
      const harness = createCoordinatorHarness();
      const queue = harness.objectByName(QUEUE);
      const storage = harness.storageFor(QUEUE);
      const targetUserId = "11111111-1111-4111-8111-111111111111";

      // Seed the pre-index storage shape directly. Every unrelated primary key
      // sorts before the target and exceeds the historical one-page scan cap.
      for (let index = 0; index < 140; index += 1) {
        const sessionId = `lifecycle:a-${index.toString().padStart(4, "0")}`;
        await storage.put(
          `greeting:${encodeURIComponent(sessionId)}`,
          greeting(sessionId, { platformUserId: `other-${index}` }),
        );
      }
      const targetSessionId = "lifecycle:z-target";
      await storage.put(
        `greeting:${encodeURIComponent(targetSessionId)}`,
        greeting(targetSessionId, { platformUserId: targetUserId }),
      );

      const claimed = await greetingsOf(await drain(queue, 20, targetUserId));
      expect(claimed.map((entry) => entry.sessionId)).toEqual([
        targetSessionId,
      ]);
    });

    test("one recipient claim scans past a full page of live leases", async () => {
      const harness = createCoordinatorHarness();
      const queue = harness.objectByName(QUEUE);
      const storage = harness.storageFor(QUEUE);
      const owner = "11111111-1111-4111-8111-111111111111";
      const recipientPrefix = `greeting-recipient:${encodeURIComponent(owner)}:`;
      const lease = { id: "already-leased", expiresAt: Date.now() + 60_000 };

      for (let index = 0; index < 128; index += 1) {
        const sessionId = `lifecycle:a-${index.toString().padStart(4, "0")}`;
        const entry = greeting(sessionId, { platformUserId: owner, lease });
        await storage.put(
          `${recipientPrefix}${encodeURIComponent(sessionId)}`,
          entry,
        );
        await storage.put(`greeting:${encodeURIComponent(sessionId)}`, entry);
      }
      const targetSessionId = "lifecycle:z-eligible";
      const target = greeting(targetSessionId, { platformUserId: owner });
      await storage.put(
        `${recipientPrefix}${encodeURIComponent(targetSessionId)}`,
        target,
      );
      await storage.put(
        `greeting:${encodeURIComponent(targetSessionId)}`,
        target,
      );
      await storage.put("greeting-recipient-index-complete:v1", true);

      const claimed = await greetingsOf(await drain(queue, 20, owner));
      expect(claimed.map((entry) => entry.sessionId)).toEqual([
        targetSessionId,
      ]);
    });

    test("recipient-scoped acknowledgement cannot consume another user's lease", async () => {
      const harness = createCoordinatorHarness();
      const queue = harness.objectByName(QUEUE);
      const owner = "11111111-1111-4111-8111-111111111111";
      const other = "22222222-2222-4222-8222-222222222222";
      const sessionId = "lifecycle:recipient-owned";
      await enqueue(queue, greeting(sessionId, { platformUserId: owner }));

      const [claimed] = await greetingsOf(await drain(queue, 20, owner));
      expect(claimed).toBeDefined();
      const acknowledgement = [{ sessionId, leaseId: claimed?.leaseId ?? "" }];
      const wrongRecipient = await acknowledge(queue, acknowledgement, other);
      expect((await wrongRecipient.json()) as unknown).toEqual({
        acknowledged: 0,
      });
      const ownerAcknowledgement = await acknowledge(
        queue,
        acknowledgement,
        owner,
      );
      expect((await ownerAcknowledgement.json()) as unknown).toEqual({
        acknowledged: 1,
      });
      expect(await greetingsOf(await drain(queue, 20, owner))).toEqual([]);
    });

    test("recipient and gateway claimers share one exactly-once lease", async () => {
      const harness = createCoordinatorHarness();
      const queue = harness.objectByName(QUEUE);
      const owner = "11111111-1111-4111-8111-111111111111";
      const sessionId = "lifecycle:shared-lease";
      await enqueue(queue, greeting(sessionId, { platformUserId: owner }));

      const [recipientLease] = await greetingsOf(await drain(queue, 20, owner));
      expect(recipientLease).toBeDefined();
      expect(await greetingsOf(await drain(queue))).toEqual([]);

      const acknowledged = await acknowledge(
        queue,
        [{ sessionId, leaseId: recipientLease?.leaseId ?? "" }],
        owner,
      );
      expect((await acknowledged.json()) as unknown).toEqual({
        acknowledged: 1,
      });
      expect(await greetingsOf(await drain(queue))).toEqual([]);
    });

    test("re-enqueueing the same session id preserves the original work", async () => {
      const harness = createCoordinatorHarness();
      const queue = harness.objectByName(QUEUE);

      await enqueue(queue, greeting("platform:discord:dup"));
      await enqueue(
        queue,
        greeting("platform:discord:dup", { message: "second write" }),
      );

      const claimed = (await greetingsOf(await drain(queue))) as Array<{
        sessionId: string;
        message?: string;
      }>;
      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.message).toBe("you're all set");
    });

    test("expired greetings are dropped at drain time, never delivered", async () => {
      const harness = createCoordinatorHarness();
      const queue = harness.objectByName(QUEUE);

      await enqueue(
        queue,
        greeting("platform:discord:stale", {
          createdAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
        }),
      );
      await enqueue(queue, greeting("platform:discord:fresh"));

      const claimed = await greetingsOf(await drain(queue));
      expect(claimed.map((entry) => entry.sessionId)).toEqual([
        "platform:discord:fresh",
      ]);
      // The stale entry was deleted, not left behind.
      expect(await greetingsOf(await drain(queue))).toEqual([]);
    });

    test("malformed enqueue payloads are rejected with 400", async () => {
      const harness = createCoordinatorHarness();
      const queue = harness.objectByName(QUEUE);

      const cases: unknown[] = [
        {},
        greeting("platform:discord:x", { platformUserId: "" }),
        greeting("platform:discord:x", { message: "" }),
        greeting("platform:discord:x", { message: "y".repeat(2001) }),
        greeting("platform:discord:x", { createdAt: "not-a-date" }),
        greeting("short", {}),
      ];
      for (const body of cases) {
        expect((await enqueue(queue, body)).status).toBe(400);
      }
      expect(await greetingsOf(await drain(queue))).toEqual([]);
    });

    test("greeting enqueues only after the turn's durable commit (no false-success DM)", async () => {
      const harness = createCoordinatorHarness();
      const { coordinator, sessionId } = harness;
      const queue = harness.objectByName(QUEUE);

      await turn(
        coordinator,
        sessionId,
        "My name is Sam",
        "discord:greet-commit-1",
      );
      expect(await greetingsOf(await drain(queue))).toEqual([]);

      const browserTurn = () =>
        coordinator.fetch(
          new Request("https://onboarding.test/turn", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              sessionId,
              input: {
                sessionId,
                platform: "web",
                idempotencyKey: "web:greet-commit",
                confirmPlatformLink: true,
                authenticatedUser: {
                  userId: "user-1",
                  organizationId: "org-1",
                },
              },
            }),
          }),
        );

      // The browser continuation binds the account in memory, then the
      // provisioning status read throws BEFORE the durable transaction
      // commits. The turn
      // fails and the greeting must not exist anywhere: the user would be
      // DMed "you're all set" for a sign-in that did not persist.
      provisioningFailure = new Error("transient provisioning outage");
      try {
        expect((await browserTurn()).status).toBe(500);
      } finally {
        provisioningFailure = undefined;
      }
      expect(await greetingsOf(await drain(queue))).toEqual([]);

      // Retrying after the outage commits the turn and enqueues exactly one
      // greeting; the committed result never exposes the internal handoff.
      const retried = await browserTurn();
      expect(retried.status).toBe(200);
      const committed = (await retried.json()) as Record<string, unknown>;
      expect("proactiveGreeting" in committed).toBe(false);
      const claimed = await greetingsOf(await drain(queue));
      expect(claimed.map((entry) => entry.sessionId)).toEqual([sessionId]);

      // A transport replay of the committed turn must not re-enqueue.
      expect((await browserTurn()).status).toBe(200);
      expect(await greetingsOf(await drain(queue))).toEqual([]);
    });

    test("a post-commit continuation-bind failure does not lose the greeting", async () => {
      // Regression (PR #18353 review): the transaction commits, then the
      // fallible cross-DO /bind runs. When the greeting enqueued only after a
      // successful bind, a transient /bind outage permanently suppressed it —
      // the same-key retry hits the replay branch (stripped, committed shape;
      // must never re-enqueue) and a fresh-key retry sees an already-bound
      // session and records no handoff. The enqueue therefore runs after the
      // durable commit but BEFORE the bind; this pins that ordering.
      const harness = createCoordinatorHarness();
      const { coordinator, sessionId } = harness;
      const queue = harness.objectByName(QUEUE);

      const first = await readResult(
        await turn(
          coordinator,
          sessionId,
          "My name is Sam",
          "discord:bind-fail-1",
        ),
      );
      const token = first.session.continuationToken;
      if (!token) throw new Error("expected a continuation token");

      // Sabotage exactly the /bind endpoint on the token's DO, once.
      const tokenObject = harness.objectByName(token);
      const realFetch = tokenObject.fetch.bind(tokenObject);
      let bindFailures = 1;
      tokenObject.fetch = async (request: Request) => {
        if (new URL(request.url).pathname === "/bind" && bindFailures > 0) {
          bindFailures -= 1;
          return new Response("bind outage", { status: 503 });
        }
        return realFetch(request);
      };

      const browserTurn = () =>
        coordinator.fetch(
          new Request("https://onboarding.test/turn", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              sessionId,
              input: {
                sessionId,
                platform: "web",
                idempotencyKey: "web:bind-fail",
                confirmPlatformLink: true,
                authenticatedUser: {
                  userId: "user-1",
                  organizationId: "org-1",
                },
              },
            }),
          }),
        );

      // The turn fails on the bind — but the sign-in itself durably
      // committed, so the greeting must already be claimable.
      expect((await browserTurn()).status).toBe(500);
      const afterFailure = await greetingsOf(await drain(queue));
      expect(afterFailure.map((entry) => entry.sessionId)).toEqual([sessionId]);

      // The retry replays the committed turn, re-binds successfully, and
      // must not enqueue a duplicate greeting.
      expect((await browserTurn()).status).toBe(200);
      expect(await greetingsOf(await drain(queue))).toEqual([]);
    });

    test("greeting keys never collide with session or replay storage", async () => {
      const harness = createCoordinatorHarness();
      const { coordinator, sessionId } = harness;

      // A real onboarding turn and a greeting in the SAME durable object
      // instance must not interfere.
      await turn(coordinator, sessionId, "My name is Sam", "discord:msg-1");
      await enqueue(coordinator, greeting(sessionId));

      const claimed = await greetingsOf(await drain(coordinator));
      expect(claimed.map((entry) => entry.sessionId)).toEqual([sessionId]);

      // The session survives the drain untouched.
      const followUp = await readResult(
        await turn(coordinator, sessionId, "still here?", "discord:msg-2"),
      );
      expect(
        followUp.session.history.some(
          (message: { content: string }) =>
            message.content === "My name is Sam",
        ),
      ).toBe(true);
    });
  });
});
