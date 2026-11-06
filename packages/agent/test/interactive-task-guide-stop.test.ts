/**
 * A person's Stop against the guided website workflow, over the real task
 * runtime, SQLite store and HTTP pause route. The browser is a stand-in that
 * counts presses; it is not Chromium.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ElizaError,
  TASK_ACTION_NOT_DISPATCHED,
  type TaskActionProposal,
  type TaskObservation,
} from "@elizaos/core/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createInteractiveTaskHandler } from "../src/services/interactive-task-http.ts";
import { InteractiveTaskRuntime } from "../src/services/interactive-task-runtime.ts";
import { SqliteInteractiveTaskStore } from "../src/services/interactive-task-store.ts";

// The workflow is plain ESM with no type declarations.
const workflowModule = new URL(
  "../../../plugins/plugin-personal-assistant/native-host/guided-website-workflow.mjs",
  import.meta.url,
).href;
const { GuidedWebsiteWorkflow } = await import(workflowModule);

const owner = {
  actorId: "actor",
  agentId: "agent",
  connector: { source: "browser", accountId: "account" },
};
const origin = "https://library.example";

/** A wait the test opens once the code reaches it. */
function gate() {
  let reach!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    reached,
    open,
    async wait() {
      reach();
      await opened;
    },
  };
}

type Hold = "observe" | "quiesce" | "click";
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** One task on a page with one button the planner always asks to press. */
function guide() {
  const directory = mkdtempSync(join(tmpdir(), "eliza-guide-stop-"));
  const db = new DatabaseSync(join(directory, "host.sqlite"));
  cleanups.push(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const holds = new Map<Hold, ReturnType<typeof gate>>();
  // Holds apply only after the guide moved the task to a new epoch.
  let armedAt = Number.POSITIVE_INFINITY;
  const held = async (kind: Hold) => {
    const hold = holds.get(kind);
    if (!hold || runtime.get(taskId).epoch <= armedAt) return;
    holds.delete(kind);
    await hold.wait();
  };
  let read: { observation: TaskObservation; snapshot: unknown } | null = null;
  let observed = 0;
  const browser = { clicks: 0 };
  const actuator = {
    capabilities: ["browser.click"],
    async quiesce() {
      await held("quiesce");
    },
    // Ignores the abort signal on purpose: the runtime must fence the read.
    async observe({ taskId: id }: { taskId: string }) {
      await held("observe");
      const task = runtime.get(id);
      const observation = {
        id: `snap-${++observed}`,
        pageId: "doc-a",
        origin,
        version: (task.observation?.version ?? 0) + 1,
        inputRevision: 1,
        observedAt: Date.now(),
      };
      read = {
        observation,
        snapshot: {
          url: `${origin}/news`,
          documentId: "doc-a",
          inputRevision: 1,
          title: "Library",
          text: "Press to see the news.",
          elements: [
            {
              tag: "button",
              type: "button",
              label: "Show news",
              selector: `${observation.id}:0:0`,
              targetSelector: "#news",
            },
          ],
        },
      };
      return observation;
    },
    readObservation: () => structuredClone(read),
    async showGuidance() {
      return {};
    },
    async execute(
      _proposal: TaskActionProposal,
      { isCurrent }: { isCurrent: () => boolean },
    ) {
      await held("click");
      // The browser checks authority immediately before the effect.
      if (!isCurrent())
        throw new ElizaError("Not sent", { code: TASK_ACTION_NOT_DISPATCHED });
      browser.clicks++;
      return { status: "succeeded" as const, evidenceRef: "evidence-1" };
    },
  };
  const store = new SqliteInteractiveTaskStore(db);
  const runtime = new InteractiveTaskRuntime({ owner, store, actuator });
  const taskId = runtime.create({
    id: "task-1",
    goalRef: "goal/news",
    authorization: {
      decisionId: "grant",
      policyRevision: "policy",
      state: "active",
      decidedAt: new Date().toISOString(),
      revokedAt: null,
    },
    allowedCapabilities: ["browser.click"],
    allowedOrigins: [origin],
  }).id;
  const handler = createInteractiveTaskHandler({
    runtime,
    authenticate: async () => owner,
    authorizeGoal: async () => {
      throw new Error("No new task expected");
    },
  });
  const workflow = new GuidedWebsiteWorkflow({
    runtime,
    actuator,
    taskId,
    planStep: async ({
      page,
    }: {
      page: { controls: Array<{ ref: string }> };
    }) => ({
      status: "act",
      kind: "agent-action",
      action: "click",
      ref: page.controls[0].ref,
      step: "Show the news",
      message: "Showing the news",
    }),
    authorizeAction: () => true,
  });
  return {
    runtime,
    taskId,
    workflow,
    browser,
    /** Hold the next `kind` call made under a newer epoch than now. */
    hold(kind: Hold) {
      armedAt = runtime.get(taskId).epoch;
      const hold = gate();
      holds.set(kind, hold);
      return hold;
    },
    /** The person's Stop or Close: one request, as the dock sends it. */
    async stop(body: Record<string, unknown> = {}) {
      const response = await handler(
        new Request("http://localhost/tasks/current/pause", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      return {
        status: response.status,
        task: ((await response.json()) as { task: { status: string } }).task,
      };
    },
  };
}

describe("a Stop against a guided website step", () => {
  it.each([
    ["Stop", {}],
    ["Close", { reason: "close" }],
  ])(
    "%s while the guide reads the page for a new step: nothing is pressed",
    async (_name, body) => {
      const g = guide();
      const offer = await g.workflow.refresh();
      expect(offer.kind).toBe("agent-action");
      const reading = g.hold("observe");
      const dispatch = g.workflow.executeAction(offer.offerKey);
      await reading.reached;
      // The guide's own new binding is not a Stop: only her Stop pauses.
      const bound = g.runtime.get(g.taskId);
      expect(bound.status).toBe("active");
      const stop = await g.stop(body);
      expect(stop).toMatchObject({ status: 200, task: { status: "paused" } });
      reading.open();
      await expect(dispatch).rejects.toThrow();
      const task = g.runtime.get(g.taskId);
      expect(task.status).toBe("paused");
      expect(task.revision).toBeGreaterThan(bound.revision);
      expect(task.operations).toEqual([]);
      expect(g.browser.clicks).toBe(0);
    },
  );

  it("a Stop while the guide's new binding settles is not undone", async () => {
    const g = guide();
    const offer = await g.workflow.refresh();
    const settling = g.hold("quiesce");
    const dispatch = g.workflow.executeAction(offer.offerKey);
    await settling.reached;
    // The pause commits when the request arrives; its answer then waits for
    // the guide's cleanup to finish.
    const stop = g.stop();
    await expect.poll(() => g.runtime.get(g.taskId).status).toBe("paused");
    settling.open();
    expect((await stop).status).toBe(200);
    await expect(dispatch).rejects.toThrow();
    expect(g.runtime.get(g.taskId).status).toBe("paused");
    expect(g.browser.clicks).toBe(0);
  });

  it("a Stop while the press is on its way fences it now as an unknown outcome", async () => {
    const g = guide();
    const offer = await g.workflow.refresh();
    const pressing = g.hold("click");
    const dispatch = g.workflow.executeAction(offer.offerKey);
    await pressing.reached;
    expect(g.runtime.get(g.taskId).status).toBe("waiting");
    expect(await g.stop()).toMatchObject({
      status: 200,
      task: { status: "paused" },
    });
    pressing.open();
    expect(await dispatch).toMatchObject({ kind: "unknown-outcome" });
    const task = g.runtime.get(g.taskId);
    expect(task.status).toBe("paused");
    expect(task.operations.map((operation) => operation.status)).toEqual([
      "unknown",
    ]);
    expect(g.browser.clicks).toBe(0);
  });

  it("the guide never takes a new binding on a stopped task", () => {
    const g = guide();
    const paused = g.runtime.control(g.taskId, 0, "pause");
    expect(() => g.runtime.rebind(g.taskId, paused.revision)).toThrow(
      expect.objectContaining({ code: "TASK_NOT_ACTIVE" }),
    );
    expect(g.runtime.get(g.taskId)).toMatchObject({
      status: "paused",
      revision: paused.revision,
    });
  });

  it("without a Stop the step is pressed once and the task stays active", async () => {
    const g = guide();
    const offer = await g.workflow.refresh();
    await g.workflow.executeAction(offer.offerKey);
    expect(g.browser.clicks).toBe(1);
    const task = g.runtime.get(g.taskId);
    expect(task.status).toBe("active");
    expect(
      g.runtime.events(g.taskId).events.map((event) => event.kind),
    ).not.toContain("pause");
  });
});
