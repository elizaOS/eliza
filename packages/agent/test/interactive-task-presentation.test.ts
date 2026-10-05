/** Actual task HTTP admission, disk SQLite presentation and filesystem selection effects. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { InteractiveTaskChoices } from "../src/services/interactive-task-choices.ts";
import { createInteractiveTaskHandler } from "../src/services/interactive-task-http.ts";
import { SqliteTaskPresentation } from "../src/services/interactive-task-presentation.ts";
import { InteractiveTaskRuntime } from "../src/services/interactive-task-runtime.ts";
import { SqliteInteractiveTaskStore } from "../src/services/interactive-task-store.ts";
import { SqliteMessageInteractionSessionStore } from "../src/services/sqlite-message-interaction-session-store.ts";

import { listenTaskHttp } from "./fixtures/task-http-server.ts";

const block = {
  kind: "choice" as const,
  id: "method",
  scope: "review",
  prompt: "Choose a method",
  options: [{ value: "existing", label: "Use existing method" }],
};
const context = "a".repeat(64);
async function setup(filename?: string) {
  const directory = mkdtempSync(join(tmpdir(), "task-presentation-host-"));
  const effectFile = join(directory, "selection.txt");
  const db = new DatabaseSync(filename ?? join(directory, "journal.sqlite"));
  db.exec("PRAGMA synchronous = FULL");
  const owner = {
    actorId: "actor",
    agentId: "agent",
    connector: { source: "host", accountId: "account" },
  };
  const tasks = new SqliteInteractiveTaskStore(db),
    sessions = new SqliteMessageInteractionSessionStore(db);
  let observations = 0;
  const actuator = {
    capabilities: [],
    observe: async () => {
      observations++;
      return {
        id: `view-${observations}`,
        pageId: "page",
        origin: "https://example.org",
        version: observations,
        inputRevision: 0,
        observedAt: 1000,
      };
    },
    execute: async () => {
      throw new Error("No action allowed");
    },
  };
  const runtime = new InteractiveTaskRuntime({
    owner,
    store: tasks,
    actuator,
    now: () => 1000,
  });
  const authorizedGoal = {
    id: "task",
    goalRef: "goal",
    authorization: {
      decisionId: "grant",
      policyRevision: "policy",
      state: "active" as const,
      decidedAt: new Date(1000).toISOString(),
      revokedAt: null,
    },
    allowedCapabilities: [],
    allowedOrigins: ["https://example.org"],
  };
  const http = await listenTaskHttp(
    createInteractiveTaskHandler({
      runtime,
      authenticate: async (request) =>
        request.headers.get("authorization") === "valid" ? owner : null,
      authorizeGoal: async (goalRef) => ({ ...authorizedGoal, goalRef }),
    }),
  );
  try {
    const started = await http.call("/tasks", { goalRef: "goal" });
    if (started.status !== 201)
      throw new Error("Host rejected the fixture task");
  } catch (error) {
    await http.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  let now = 1500;
  const choices = new InteractiveTaskChoices(runtime, sessions, () => now);
  return {
    db,
    http,
    effectFile,
    async close() {
      await http.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
    runtime,
    tasks,
    sessions,
    choices,
    actuator,
    get observations() {
      return observations;
    },
    owner,
    presentation: new SqliteTaskPresentation(db, runtime, choices),
    expire: () => {
      now += 1000000;
    },
  };
}
describe("durable task presentation delivery", () => {
  it("reopens the same presentation and reads live commitment without a new task operation", async () => {
    const t = await setup();
    try {
      const offered = await t.presentation.publish("task", context, block);
      const revision = t.runtime.get("task").revision;
      const reader = new SqliteTaskPresentation(t.db, t.runtime, t.choices);
      expect(await reader.read("task")).toEqual(offered);
      let effects = 0;
      await t.choices.respond({
        taskId: "task",
        contextKey: context,
        callbackData: offered.callbackData,
        value: "existing",
        execute: async () => {
          writeFileSync(t.effectFile, "Chosen existing method");
          effects++;
          return {
            accepted:
              readFileSync(t.effectFile, "utf8") === "Chosen existing method",
          };
        },
      });
      expect((await reader.read("task"))?.state).toBe("completed");
      expect((await reader.read("task"))?.state).toBe("completed");
      expect(effects).toBe(1);
      expect(readFileSync(t.effectFile, "utf8")).toBe("Chosen existing method");
      expect(t.observations).toBe(0);
      expect(t.runtime.get("task").revision).toBe(revision);
    } finally {
      await t.close();
    }
  });
  it("suppresses old epochs after Pause and Resume", async () => {
    const t = await setup();
    try {
      await t.presentation.publish("task", context, block);
      expect(
        (
          await t.http.call("/tasks/task/pause", {
            expectedRevision: t.runtime.get("task").revision,
          })
        ).status,
      ).toBe(200);
      expect(await t.presentation.read("task")).toBeNull();
      await t.runtime.observe("task", t.runtime.get("task").revision, true);
      expect(await t.presentation.read("task")).toBeNull();
      const next = await t.presentation.publish("task", context, block);
      expect(await t.presentation.read("task")).toEqual(next);
    } finally {
      await t.close();
    }
  });
  it("suppresses expired offers and rejects forged presentation labels", async () => {
    const t = await setup();
    try {
      const offered = await t.presentation.publish("task", context, block);
      await expect(
        t.choices.refresh({
          ...offered,
          block: { ...block, prompt: "Forged instructions" },
        }),
      ).rejects.toMatchObject({ code: "TASK_CHOICE_STALE" });
      t.expire();
      expect(await t.presentation.read("task")).toBeNull();
    } finally {
      await t.close();
    }
  });
  it("does not expose another actor's presentation", async () => {
    const t = await setup();
    try {
      await t.presentation.publish("task", context, block);
      const runtime = new InteractiveTaskRuntime({
        owner: { ...t.owner, actorId: "other" },
        store: t.tasks,
        actuator: t.actuator,
        now: () => 1000,
      });
      const reader = new SqliteTaskPresentation(
        t.db,
        runtime,
        new InteractiveTaskChoices(runtime, t.sessions),
      );
      await expect(reader.read("task")).rejects.toThrow();
    } finally {
      await t.close();
    }
  });
  it("newer concurrent publication wins without allowing a late overwrite", async () => {
    const t = await setup();
    try {
      const first = t.presentation.publish("task", context, block);
      const second = t.presentation.publish("task", "b".repeat(64), {
        ...block,
        prompt: "New review",
      });
      const results = await Promise.allSettled([first, second]);
      expect(results[0].status).toBe("rejected");
      expect(results[1].status).toBe("fulfilled");
      expect((await t.presentation.read("task"))?.block.prompt).toBe(
        "New review",
      );
    } finally {
      await t.close();
    }
  });
  it("clear fences pending publication and pending reads", async () => {
    const t = await setup();
    try {
      const pending = t.presentation.publish("task", context, block);
      t.presentation.clear("task");
      await expect(pending).rejects.toMatchObject({
        code: "TASK_CHOICE_STALE",
      });
      expect(await t.presentation.read("task")).toBeNull();
      await t.presentation.publish("task", context, block);
      const reading = t.presentation.read("task");
      t.presentation.clear("task");
      expect(await reading).toBeNull();
    } finally {
      await t.close();
    }
  });
  it("rejects malformed stored presentation instead of hiding storage corruption", async () => {
    const t = await setup();
    try {
      await t.presentation.publish("task", context, block);
      t.db
        .prepare("UPDATE interactive_task_presentation_v1 SET document=?")
        .run("broken");
      await expect(t.presentation.read("task")).rejects.toMatchObject({
        code: "TASK_PRESENTATION_CORRUPT",
      });
    } finally {
      await t.close();
    }
  });
  it("captures the offered block before asynchronous storage work", async () => {
    const t = await setup();
    try {
      const supplied = structuredClone(block);
      const pending = t.presentation.publish("task", context, supplied);
      supplied.options[0].value = "changed";
      supplied.options[0].label = "Changed after offer";
      const offered = await pending;
      expect(offered.block.options[0].value).toBe("existing");
      expect(await t.presentation.read("task")).toEqual(offered);
      await expect(
        t.choices.respond({
          taskId: "task",
          contextKey: context,
          callbackData: offered.callbackData,
          value: "existing",
          execute: async () => {
            writeFileSync(t.effectFile, "Original selection");
            return {
              accepted:
                readFileSync(t.effectFile, "utf8") === "Original selection",
            };
          },
        }),
      ).resolves.toMatchObject({ status: "completed" });
    } finally {
      await t.close();
    }
  });
  it("keeps disk evidence across restart but does not deliver a recovered paused choice", async () => {
    const directory = mkdtempSync(join(tmpdir(), "task-presentation-"));
    const filename = join(directory, "journal.sqlite");
    try {
      const initial = await setup(filename);
      await initial.presentation.publish("task", context, block);
      await initial.close();
      const db = new DatabaseSync(filename);
      db.exec("PRAGMA synchronous = FULL");
      try {
        const tasks = new SqliteInteractiveTaskStore(db);
        const runtime = new InteractiveTaskRuntime({
          owner: initial.owner,
          store: tasks,
          actuator: initial.actuator,
          now: () => 2000,
        });
        const choices = new InteractiveTaskChoices(
          runtime,
          new SqliteMessageInteractionSessionStore(db),
          () => 2000,
        );
        expect(runtime.get("task").status).toBe("paused");
        expect(
          await new SqliteTaskPresentation(db, runtime, choices).read("task"),
        ).toBeNull();
        expect(
          db
            .prepare(
              "SELECT count(*) AS count FROM interactive_task_presentation_v1",
            )
            .get(),
        ).toMatchObject({ count: 1 });
      } finally {
        db.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
