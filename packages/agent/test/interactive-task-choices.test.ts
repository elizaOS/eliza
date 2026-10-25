import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { InteractiveTaskChoices } from "../src/services/interactive-task-choices.ts";
import { InteractiveTaskRuntime } from "../src/services/interactive-task-runtime.ts";
import { SqliteInteractiveTaskStore } from "../src/services/interactive-task-store.ts";
import { SqliteMessageInteractionSessionStore } from "../src/services/sqlite-message-interaction-session-store.ts";

const contextKey = "a".repeat(64);
const block = {
  kind: "choice" as const,
  id: "method",
  scope: "review",
  prompt: "Choose a method",
  options: [
    { value: "existing", label: "Use existing method" },
    { value: "manual", label: "Choose on website" },
  ],
};
function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA synchronous = FULL");
  const owner = {
    actorId: "actor",
    agentId: "agent",
    connector: { source: "host", accountId: "account" },
  };
  const store = new SqliteInteractiveTaskStore(db),
    sessions = new SqliteMessageInteractionSessionStore(db);
  const runtime = new InteractiveTaskRuntime({
    owner,
    store,
    actuator: {
      capabilities: [],
      observe: async () => {
        throw new Error("unused");
      },
      execute: async () => {
        throw new Error("unused");
      },
    },
    now: () => 1000,
  });
  runtime.create({
    id: "task",
    goalRef: "goal",
    authorization: {
      decisionId: "grant",
      policyRevision: "policy",
      state: "active",
      decidedAt: new Date(1000).toISOString(),
      revokedAt: null,
    },
    allowedCapabilities: [],
    allowedOrigins: ["https://example.org"],
  });
  let now = 1500;
  const choices = new InteractiveTaskChoices(runtime, sessions, () => now);
  return {
    db,
    runtime,
    choices,
    advance: () => {
      now += 1_000_000;
    },
  };
}
describe("task-bound durable choices", () => {
  it("reuses concurrent offers and commits one response despite duplicate delivery", async () => {
    const t = setup();
    try {
      const [a, b] = await Promise.all([
        t.choices.offer("task", contextKey, block),
        t.choices.offer("task", contextKey, block),
      ]);
      expect(a.callbackData).toBe(b.callbackData);
      let effects = 0,
        release: () => void = () => {};
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const input = {
        taskId: "task",
        contextKey,
        callbackData: a.callbackData,
        value: "existing",
        execute: async ({ isCurrent }: { isCurrent: () => boolean }) => {
          expect(isCurrent()).toBe(true);
          effects++;
          await waiting;
          return { selected: true };
        },
      };
      const first = t.choices.respond(input);
      for (let i = 0; i < 30 && effects === 0; i++) await Promise.resolve();
      expect(effects).toBe(1);
      expect((await t.choices.respond(input)).status).toBe("in_progress");
      release();
      expect((await first).status).toBe("completed");
      expect((await t.choices.respond(input)).status).toBe("replay");
      expect(effects).toBe(1);
      await expect(
        t.choices.respond({ ...input, value: "manual" }),
      ).rejects.toMatchObject({ code: "MESSAGE_INTERACTION_ALREADY_CONSUMED" });
      expect((await t.choices.offer("task", contextKey, block)).state).toBe(
        "completed",
      );
    } finally {
      t.db.close();
    }
  });
  it("rejects changed review, wrong task, unsupported response and callbacks after Pause", async () => {
    const t = setup();
    try {
      const widget = await t.choices.offer("task", contextKey, block);
      let effects = 0;
      const input = {
        taskId: "task",
        contextKey,
        callbackData: widget.callbackData,
        value: "existing",
        execute: async () => {
          effects++;
          return {};
        },
      };
      await expect(
        t.choices.respond({ ...input, contextKey: "b".repeat(64) }),
      ).rejects.toMatchObject({ code: "TASK_CHOICE_STALE" });
      await expect(
        t.choices.respond({ ...input, taskId: "foreign" }),
      ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
      await expect(
        t.choices.respond({ ...input, value: "pay-now" }),
      ).rejects.toMatchObject({ code: "INVALID_MESSAGE_INTERACTION_RESPONSE" });
      t.runtime.control("task", t.runtime.get("task").revision, "pause");
      await expect(t.choices.respond(input)).rejects.toMatchObject({
        code: "TASK_CHOICE_STALE",
      });
      expect(effects).toBe(0);
    } finally {
      t.db.close();
    }
  });
  it("keeps expired offers expired and exposes epoch invalidation during an effect", async () => {
    const t = setup();
    try {
      const widget = await t.choices.offer("task", contextKey, block);
      t.advance();
      await expect(
        t.choices.respond({
          taskId: "task",
          contextKey,
          callbackData: widget.callbackData,
          value: "existing",
          execute: async () => {
            throw new Error("must not execute");
          },
        }),
      ).rejects.toMatchObject({ code: "MESSAGE_INTERACTION_EXPIRED" });
      expect((await t.choices.offer("task", contextKey, block)).expiresAt).toBe(
        widget.expiresAt,
      );
      const fresh = await t.choices.offer("task", "b".repeat(64), block);
      await t.choices.respond({
        taskId: "task",
        contextKey: "b".repeat(64),
        callbackData: fresh.callbackData,
        value: "manual",
        execute: async ({ isCurrent }) => {
          t.runtime.control("task", t.runtime.get("task").revision, "pause");
          expect(isCurrent()).toBe(false);
          return { performed: false };
        },
      });
    } finally {
      t.db.close();
    }
  });
});
