/**
 * A person's Stop and her yes against the guided website workflow, over the
 * real task runtime, SQLite store and HTTP pause route. The browser is a
 * stand-in that counts presses; it is not Chromium.
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

type Authorize = (
  input: unknown,
  context: { phase: "plan" | "dispatch"; authorize?: () => unknown },
) => unknown;
/** The host's consent policy: it asks first; at dispatch it authorizes. */
const authorizeAtDispatch: Authorize = (_input, context) =>
  context.phase === "dispatch" ? context.authorize?.() : true;

/** One task on a page with one button the planner always asks to press. */
function guide({
  ask = false,
  authorizeAction = authorizeAtDispatch,
}: {
  ask?: boolean;
  authorizeAction?: Authorize;
} = {}) {
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
  const browser = { clicks: 0, text: "Press to see the news." };
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
          text: browser.text,
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
    authorizeAction,
    // The host's question before this step, when it needs her yes.
    checkStep: async () =>
      ask
        ? { key: "ask:show-news", reason: "money", message: "Is that OK?" }
        : null,
  });
  return {
    runtime,
    taskId,
    workflow,
    browser,
    /**
     * Hold the next `kind` call made under a newer epoch than now, or with
     * `now`, the next one in this epoch too.
     */
    hold(kind: Hold, { now = false } = {}) {
      armedAt = runtime.get(taskId).epoch - (now ? 1 : 0);
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

describe("a yes to a guided step", () => {
  it("is used up by one press: the same step on the same page asks again", async () => {
    const g = guide({ ask: true });
    expect(await g.workflow.refresh()).toMatchObject({
      kind: "person-check",
      key: "ask:show-news",
    });
    g.workflow.acknowledge("ask:show-news");
    const offer = await g.workflow.refresh();
    expect(offer.kind).toBe("agent-action");
    const after = await g.workflow.executeAction(offer.offerKey);
    expect(g.browser.clicks).toBe(1);
    // The page still shows the button: her one yes gave one press.
    expect(after).toMatchObject({ kind: "person-check", key: "ask:show-news" });
    expect(g.browser.clicks).toBe(1);
  });

  it("survives the guide's own new binding when the page changed before the press", async () => {
    const g = guide({ ask: true });
    await g.workflow.refresh();
    g.workflow.acknowledge("ask:show-news");
    const offer = await g.workflow.refresh();
    const reading = g.hold("observe");
    const dispatch = g.workflow.executeAction(offer.offerKey);
    await reading.reached;
    // The page changes while the guide reads it under its new binding, so
    // it plans again without pressing.
    g.browser.text = "Press to see today's news.";
    reading.open();
    expect(await dispatch).toMatchObject({ kind: "agent-action" });
    expect(g.browser.clicks).toBe(0);
  });

  it("from a question asked before a new epoch is ignored", async () => {
    const g = guide({ ask: true });
    const asked = await g.workflow.refresh();
    const askedIn = g.runtime.get(g.taskId).epoch;
    // The question names the epoch it was asked in.
    expect(asked).toMatchObject({ kind: "person-check", epoch: askedIn });
    await g.stop();
    const paused = g.runtime.get(g.taskId);
    await g.runtime.observe(g.taskId, paused.revision, true);
    // A late yes to the question asked before her Stop and Resume.
    g.workflow.acknowledge("ask:show-news", { epoch: askedIn });
    expect(await g.workflow.refresh()).toMatchObject({
      kind: "person-check",
      key: "ask:show-news",
    });
    const again = await g.workflow.refresh();
    expect(again.epoch).toBe(g.runtime.get(g.taskId).epoch);
    expect(again.epoch).not.toBe(askedIn);
    g.workflow.acknowledge("ask:show-news", { epoch: again.epoch });
    expect((await g.workflow.refresh()).kind).toBe("agent-action");
    expect(g.browser.clicks).toBe(0);
  });

  it("does not outlive her Stop", async () => {
    const g = guide({ ask: true });
    await g.workflow.refresh();
    g.workflow.acknowledge("ask:show-news");
    expect((await g.workflow.refresh()).kind).toBe("agent-action");
    await g.stop();
    const paused = g.runtime.get(g.taskId);
    await g.runtime.observe(g.taskId, paused.revision, true);
    expect(await g.workflow.refresh()).toMatchObject({
      kind: "person-check",
      key: "ask:show-news",
    });
    expect(g.browser.clicks).toBe(0);
  });

  it("an offer armed before her Stop and Resume never presses", async () => {
    const g = guide({ ask: true });
    await g.workflow.refresh();
    g.workflow.acknowledge("ask:show-news");
    const offer = await g.workflow.refresh();
    expect(offer.kind).toBe("agent-action");
    await g.stop();
    const paused = g.runtime.get(g.taskId);
    await g.runtime.observe(g.taskId, paused.revision, true);
    // The host presses the offer it got before the Stop, with no refresh.
    expect(await g.workflow.executeAction(offer.offerKey)).toMatchObject({
      kind: "person-check",
      key: "ask:show-news",
    });
    expect(g.browser.clicks).toBe(0);
  });

  it("her Stop before the guide's new binding answers paused", async () => {
    const g = guide();
    const offer = await g.workflow.refresh();
    const hiding = g.hold("quiesce", { now: true });
    const dispatch = g.workflow.executeAction(offer.offerKey);
    await hiding.reached;
    expect(await g.stop()).toMatchObject({
      status: 200,
      task: { status: "paused" },
    });
    hiding.open();
    expect(await dispatch).toEqual({ kind: "paused", taskId: g.taskId });
    expect(g.browser.clicks).toBe(0);
  });

  it("two presses of the same Yes give one effect", async () => {
    const g = guide();
    const offer = await g.workflow.refresh();
    const results = await Promise.allSettled([
      g.workflow.executeAction(offer.offerKey),
      g.workflow.executeAction(offer.offerKey),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(g.browser.clicks).toBe(1);
    expect(
      g.runtime.get(g.taskId).operations.map((operation) => operation.status),
    ).toEqual(["succeeded"]);
  });

  it("waits for a background page read instead of cancelling it to press", async () => {
    const g = guide();
    const offer = await g.workflow.refresh();
    const reading = g.hold("observe", { now: true });
    const background = g.workflow.refresh();
    await reading.reached;
    expect(await g.workflow.executeAction(offer.offerKey)).toMatchObject({
      kind: "blocked",
      reasonCode: "task-busy",
    });
    expect(g.browser.clicks).toBe(0);
    reading.open();
    const fresh = await background;
    expect(fresh.kind).toBe("agent-action");
    await g.workflow.executeAction(fresh.offerKey);
    expect(g.browser.clicks).toBe(1);
  });

  it("a planning answer never authorizes the press", async () => {
    // A host that answers true in both phases, as before dispatch had its own.
    const g = guide({ authorizeAction: () => true });
    const offer = await g.workflow.refresh();
    expect(offer.kind).toBe("agent-action");
    // The old contract is named, not mistaken for a missing target.
    await expect(g.workflow.executeAction(offer.offerKey)).rejects.toThrow(
      /return context\.authorize\(\)/,
    );
    expect(g.browser.clicks).toBe(0);
    expect(g.runtime.get(g.taskId).operations).toEqual([]);
  });

  it("a dispatch answer other than the grant is no target", async () => {
    const g = guide({
      authorizeAction: (_input, context) =>
        context.phase === "plan" ? true : { offer: "forged" },
    });
    const offer = await g.workflow.refresh();
    expect(await g.workflow.executeAction(offer.offerKey)).toMatchObject({
      kind: "blocked",
      reasonCode: "no-target",
    });
    expect(g.browser.clicks).toBe(0);
  });
});
