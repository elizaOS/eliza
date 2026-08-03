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

mock.module("../../shared/src/lib/services/eliza-app/provisioning", () => ({
  ensureElizaAppProvisioning: mock(async () => noProvisioning),
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
  authenticatedUser?: { userId: string; organizationId: string },
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

async function readResult(response: Response): Promise<OnboardingChatResult> {
  return (await response.json()) as OnboardingChatResult;
}

describe("OnboardingSessionCoordinator", () => {
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
    const replayKey = `replay:${scope}:${encodeURIComponent("discord:message-1")}`;
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
    const replayKey = `replay:${scope}:${encodeURIComponent("discord:message-1")}`;
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
      await storage.get(`replay:${accountAScope}:discord%3Amessage-1`),
    ).toBeDefined();
    expect(
      await storage.get(`replay:${accountBScope}:discord%3Amessage-1`),
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
});
