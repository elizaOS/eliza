/**
 * Pending-prompts barrel unit test — verifies `index.ts` re-exports the real
 * service and store implementations with their contracts intact when reached
 * through the public directory entrypoint.
 *
 * Every case drives the live modules imported only from `./index.ts` against
 * a JSON-round-tripped in-memory cache double, so a broken re-export, a
 * miswired service lookup key, or a lost store mutation fails here. Real
 * harness: no production code is mocked.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  createPendingPromptsStore,
  PENDING_PROMPTS_SERVICE,
  PendingPromptsService,
  resolvePendingPromptsService,
} from "./index.ts";

const ROOM_INDEX_KEY = "eliza:lifeops:pending-prompts:rooms:v1";
const roomCacheKey = (roomId: string) =>
  `eliza:lifeops:pending-prompts:room:${roomId}:v1`;

// Far-future fixtures so no entry sits inside its 24h retain window's past
// when a case reads without an explicit `now`.
const FIRED_AT = "2099-01-01T00:00:00.000Z";
const RETAIN_DEFAULT_UNTIL = "2099-01-02T00:00:00.000Z";

function makeRuntime(): { runtime: IAgentRuntime; rows: Map<string, string> } {
  const rows = new Map<string, string>();
  const runtime = {
    agentId: "test-agent",
    // The real cache round-trips through the adapter, so serialize rather
    // than handing back live references.
    async getCache<T>(key: string): Promise<T | null> {
      const raw = rows.get(key);
      return raw === undefined ? null : (JSON.parse(raw) as T);
    },
    async setCache<T>(key: string, value: T): Promise<boolean> {
      rows.set(key, JSON.stringify(value));
      return true;
    },
    async deleteCache(key: string): Promise<boolean> {
      return rows.delete(key);
    },
  } as unknown as IAgentRuntime;
  return { runtime, rows };
}

describe("pending-prompts barrel", () => {
  it("re-exports the service type constant and the class marker consistently", () => {
    expect(PENDING_PROMPTS_SERVICE).toBe("eliza_pending_prompts");
    expect(PendingPromptsService.serviceType).toBe(PENDING_PROMPTS_SERVICE);
  });

  it("starts a working service bound to the given runtime", async () => {
    const { runtime } = makeRuntime();
    const service = await PendingPromptsService.start(runtime);
    expect(service).toBeInstanceOf(PendingPromptsService);

    const recorded = await service.getStore().record({
      taskId: "task-bind",
      roomId: "room-bind",
      promptSnippet: "  how did lunch go?  ",
      firedAt: FIRED_AT,
    });
    expect(recorded.promptSnippet).toBe("how did lunch go?");
    expect(recorded.expectedReplyKind).toBe("any");
    // Default reopen window: firedAt + 24h.
    expect(recorded.retainUntilIso).toBe(RETAIN_DEFAULT_UNTIL);

    // The list projection carries no internal storage fields.
    await expect(service.getStore().list("room-bind")).resolves.toEqual([
      {
        taskId: "task-bind",
        promptSnippet: "how did lunch go?",
        firedAt: FIRED_AT,
        expectedReplyKind: "any",
      },
    ]);
    await expect(service.stop()).resolves.toBeUndefined();
  });

  it("honors a positive reopen-window override and falls back to 24h otherwise", async () => {
    const { runtime } = makeRuntime();
    const store = createPendingPromptsStore(runtime);
    const firedAt = FIRED_AT;

    const overridden = await store.record({
      taskId: "t-override",
      roomId: "room-window",
      promptSnippet: "s",
      firedAt,
      reopenWindowHours: 3,
    });
    expect(overridden.retainUntilIso).toBe("2099-01-01T03:00:00.000Z");

    for (const reopenWindowHours of [0, -1, Number.NaN]) {
      const defaulted = await store.record({
        taskId: `t-default-${reopenWindowHours}`,
        roomId: "room-window",
        promptSnippet: "s",
        firedAt,
        reopenWindowHours,
      });
      expect(defaulted.retainUntilIso).toBe(RETAIN_DEFAULT_UNTIL);
    }
  });

  it("rejects invalid records without mutating cached state", async () => {
    const { runtime, rows } = makeRuntime();
    const store = createPendingPromptsStore(runtime);

    await expect(
      store.record({
        taskId: "",
        roomId: "room-x",
        promptSnippet: "s",
        firedAt: FIRED_AT,
      }),
    ).rejects.toThrow("[pending-prompts] taskId is required");
    await expect(
      store.record({
        taskId: "t",
        roomId: "",
        promptSnippet: "s",
        firedAt: FIRED_AT,
      }),
    ).rejects.toThrow("[pending-prompts] roomId is required");
    await expect(
      store.record({
        taskId: "t",
        roomId: "r",
        promptSnippet: "s",
        firedAt: "nope",
      }),
    ).rejects.toThrow("[pending-prompts] firedAt must be ISO-8601");
    await expect(
      store.record({
        taskId: "t",
        roomId: "r",
        promptSnippet: "s",
        firedAt: FIRED_AT,
        expiresAt: "nope",
      }),
    ).rejects.toThrow("[pending-prompts] expiresAt must be ISO-8601");

    expect(rows.size).toBe(0);
  });

  it("records per room, replaces a repeated task, orders listAll newest-first, and retires resolved-empty rooms", async () => {
    const { runtime, rows } = makeRuntime();
    const store = createPendingPromptsStore(runtime);

    await store.record({
      taskId: "task-old",
      roomId: "room-a",
      promptSnippet: "older",
      firedAt: "2099-01-01T18:00:00.000Z",
      expectedReplyKind: "yes_no",
    });
    await store.record({
      taskId: "task-new",
      roomId: "room-b",
      promptSnippet: "newer",
      firedAt: "2099-01-01T18:05:00.000Z",
      expectedReplyKind: "approval",
      expiresAt: "2099-01-01T19:05:00.000Z",
      reopenWindowHours: 2,
    });
    // Same task in the same room is replaced, not duplicated.
    await store.record({
      taskId: "task-old",
      roomId: "room-a",
      promptSnippet: "older v2",
      firedAt: "2099-01-01T18:01:00.000Z",
      expectedReplyKind: "yes_no",
    });

    // Retain window bases on expiresAt when provided: 19:05 + 2h.
    expect(await store.listAll()).toEqual([
      {
        taskId: "task-new",
        roomId: "room-b",
        promptSnippet: "newer",
        firedAt: "2099-01-01T18:05:00.000Z",
        expectedReplyKind: "approval",
        expiresAt: "2099-01-01T19:05:00.000Z",
      },
      {
        taskId: "task-old",
        roomId: "room-a",
        promptSnippet: "older v2",
        firedAt: "2099-01-01T18:01:00.000Z",
        expectedReplyKind: "yes_no",
      },
    ]);

    await store.resolve("room-b", "task-new");
    const remaining = await store.listAll();
    expect(remaining.map((prompt) => prompt.taskId)).toEqual(["task-old"]);
    // Resolving the last prompt retires the room row and its index entry.
    expect(rows.has(roomCacheKey("room-b"))).toBe(false);
    expect(rows.get(ROOM_INDEX_KEY)).toBe(JSON.stringify(["room-a"]));
  });

  it("drops entries once their retain instant is reached and applies the lookback cutoff inclusively", async () => {
    const { runtime } = makeRuntime();
    const store = createPendingPromptsStore(runtime);

    await store.record({
      taskId: "task-expiry",
      roomId: "room-expiry",
      promptSnippet: "will expire",
      firedAt: "2026-06-24T10:00:00.000Z",
      reopenWindowHours: 1,
    });
    expect(
      await store.list("room-expiry", {
        now: new Date("2026-06-24T10:59:59.999Z"),
      }),
    ).toHaveLength(1);
    // At exactly retainUntil the entry counts as expired, is hidden, and is
    // purged from storage on the read.
    expect(
      await store.list("room-expiry", {
        now: new Date("2026-06-24T11:00:00.000Z"),
      }),
    ).toHaveLength(0);

    await store.record({
      taskId: "task-lookback",
      roomId: "room-lookback",
      promptSnippet: "recent",
      firedAt: "2026-06-24T12:00:00.000Z",
    });
    const now = new Date("2026-06-24T12:10:00.000Z");
    expect(
      await store.list("room-lookback", { now, lookbackMinutes: 10 }),
    ).toHaveLength(1);
    expect(
      await store.list("room-lookback", { now, lookbackMinutes: 9 }),
    ).toHaveLength(0);
  });

  it("forgets a task across every indexed room and clears all state", async () => {
    const { runtime, rows } = makeRuntime();
    const store = createPendingPromptsStore(runtime);

    await store.record({
      taskId: "task-shared",
      roomId: "room-1",
      promptSnippet: "shared",
      firedAt: "2099-01-01T12:00:00.000Z",
    });
    await store.record({
      taskId: "task-shared",
      roomId: "room-2",
      promptSnippet: "shared",
      firedAt: "2099-01-01T12:00:00.000Z",
    });
    await store.record({
      taskId: "task-keep",
      roomId: "room-1",
      promptSnippet: "keep me",
      firedAt: "2099-01-01T12:01:00.000Z",
    });

    await store.forgetTask("task-shared");
    expect(await store.listAll()).toEqual([
      {
        taskId: "task-keep",
        roomId: "room-1",
        promptSnippet: "keep me",
        firedAt: "2099-01-01T12:01:00.000Z",
        expectedReplyKind: "any",
      },
    ]);

    await store.clearAll();
    expect(await store.listAll()).toEqual([]);
    expect(rows.size).toBe(0);
  });

  it("looks the registered service up by the barrel constant and returns it verbatim", () => {
    const requested: string[] = [];
    const sentinel = { marker: true } as unknown as PendingPromptsService;
    const hitRuntime = {
      getService: <T>(type: string): T | null => {
        requested.push(type);
        return sentinel as T;
      },
    } as unknown as IAgentRuntime;
    expect(resolvePendingPromptsService(hitRuntime)).toBe(sentinel);
    expect(requested).toEqual([PENDING_PROMPTS_SERVICE]);

    const missRuntime = {
      getService: () => null,
    } as unknown as IAgentRuntime;
    expect(resolvePendingPromptsService(missRuntime)).toBeNull();
  });

  it("projects open prompts into canonical pending user actions with kind weights", async () => {
    const { runtime } = makeRuntime();
    const service = await PendingPromptsService.start(runtime);
    expect(await service.listPendingUserActions()).toEqual([]);

    const store = service.getStore();
    await store.record({
      taskId: "t-approval",
      roomId: "room-approval",
      promptSnippet: "Approve the calendar change?",
      firedAt: FIRED_AT,
      expectedReplyKind: "approval",
      expiresAt: "2099-02-01T00:00:00.000Z",
    });
    await store.record({
      taskId: "t-yes-no",
      roomId: "room-yes-no",
      promptSnippet: "Walk today?",
      firedAt: "2099-01-01T00:01:00.000Z",
      expectedReplyKind: "yes_no",
    });
    await store.record({
      taskId: "t-any",
      roomId: "room-any",
      promptSnippet: "Anything else?",
      firedAt: "2099-01-01T00:02:00.000Z",
      expectedReplyKind: "any",
    });
    await store.record({
      taskId: "t-free-form",
      roomId: "room-free-form",
      promptSnippet: "How did lunch go?",
      firedAt: "2099-01-01T00:03:00.000Z",
    });

    const actions = await service.listPendingUserActions();
    // Globally newest-first.
    expect(actions.map((action) => action.id)).toEqual([
      "t-free-form",
      "t-any",
      "t-yes-no",
      "t-approval",
    ]);
    expect(actions.map((action) => action.weight)).toEqual([6, 6, 7, 9]);
    expect(actions.map((action) => action.source)).toEqual([
      "pending-prompts",
      "pending-prompts",
      "pending-prompts",
      "pending-prompts",
    ]);

    // Complete projection of one action, including millisecond timestamps.
    expect(actions[3]).toEqual({
      id: "t-approval",
      kind: "pending_prompt",
      source: "pending-prompts",
      title: "Approve the calendar change?",
      roomId: "room-approval",
      expectedReplyKind: "approval",
      weight: 9,
      resolution: { target: "pending_prompt", requestId: "t-approval" },
      data: { expectedReplyKind: "approval" },
      createdAt: Date.parse(FIRED_AT),
      expiresAt: Date.parse("2099-02-01T00:00:00.000Z"),
    });
    // Prompts recorded without expiresAt project a null expiry.
    expect(actions[0]?.expiresAt).toBeNull();
  });

  it("projects a cache-seeded invalid expiresAt as null while keeping the prompt visible", async () => {
    const { runtime } = makeRuntime();
    const service = await PendingPromptsService.start(runtime);
    await runtime.setCache(roomCacheKey("room-invalid"), [
      {
        roomId: "room-invalid",
        taskId: "t-invalid",
        promptSnippet: "seeded directly",
        firedAt: "2026-08-22T00:00:00.000Z",
        expectedReplyKind: "free_form",
        retainUntilIso: "2099-01-01T00:00:00.000Z",
        expiresAt: "not-a-date",
      },
    ]);
    await runtime.setCache(ROOM_INDEX_KEY, ["room-invalid"]);

    const actions = await service.listPendingUserActions();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      id: "t-invalid",
      roomId: "room-invalid",
      weight: 6,
      expiresAt: null,
    });
  });
});
