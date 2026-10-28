/** Origin scope of the task actuator against a controlled native endpoint. */
import {
  createInteractiveTask,
  type InteractiveTask,
  type TaskTransition,
  transitionInteractiveTask,
} from "@elizaos/core/protocol";
import { describe, expect, it } from "vitest";
import type { NativeTaskBinding } from "./native-socket-target.js";
import { NativeTaskActuator, type TaskBrowserPolicy } from "./task-actuator.js";

const SSA = "https://www.ssa.gov";
const LOGIN = "https://secure.login.gov";
const owner = {
  actorId: "actor",
  agentId: "agent",
  connector: { source: "browser", accountId: "account" },
};

function setup(policy: Partial<TaskBrowserPolicy> = {}) {
  let clock = 1000;
  let task = createInteractiveTask({
    id: "task-1",
    owner,
    goalRef: "goal-1",
    now: clock,
    authorization: {
      decisionId: "grant",
      policyRevision: "policy",
      state: "active",
      decidedAt: new Date(clock).toISOString(),
      revokedAt: null,
    },
    allowedCapabilities: ["browser.click"],
    allowedOrigins: [SSA],
  });
  let page = `${SSA}/start`;
  let sequence = 0;
  let revision = 0;
  const bindings: NativeTaskBinding[] = [];
  const applied: string[][] = [];
  const actuator = new NativeTaskActuator({
    target: {
      bindTask: async (binding) => {
        bindings.push(binding);
        return {
          bound: true,
          tabId: binding.tabId,
          taskId: binding.taskId,
          epoch: binding.epoch,
          bindingRevision: binding.bindingRevision,
        };
      },
      execute: async () => {
        const snapshotId = `00000000-0000-0000-0000-${String(++sequence).padStart(12, "0")}`;
        return {
          targetId: "test",
          mode: "desktop",
          subaction: "snapshot",
          value: {
            result: {
              snapshotId,
              frames: [
                {
                  frameId: 0,
                  documentId: `document-${sequence}`,
                  url: page,
                  complete: true,
                  inputRevision: 0,
                  elements: [{ selector: `${snapshotId}:0:0` }],
                },
              ],
            },
          },
        };
      },
      guideTask: async () => ({ visible: false }),
    },
    getTask: () => structuredClone(task),
    policy: () => ({
      tabId: "tab-1",
      origin: new URL(page).origin,
      leaseMs: 60000,
      targets: [],
      ...policy,
    }),
    nextBindingRevision: () => ++revision,
    resolveValue: async () => {
      throw new Error("No values used");
    },
    verify: async () => "unknown",
    recordEvidence: async () => "evidence",
    applyOrigins: async (_task, origins) => {
      applied.push([...origins]);
    },
    now: () => clock,
  });
  const apply = (change: TaskTransition) => {
    clock += 10;
    task = transitionInteractiveTask(
      task,
      { owner, expectedRevision: task.revision, now: clock },
      change,
    ).task;
    return task;
  };
  const observe = async () => {
    const observation = await actuator.observe({
      owner,
      taskId: task.id,
      signal: new AbortController().signal,
    });
    apply({ type: "observe", observation });
    return observation;
  };
  return {
    actuator,
    bindings,
    applied,
    apply,
    observe,
    goTo: (url: string) => {
      page = url;
    },
    task: (): InteractiveTask => task,
  };
}

describe("NativeTaskActuator origin scope", () => {
  it("binds a task that was never extended to its one origin, in the original wire form", async () => {
    const { bindings, observe, goTo } = setup();
    expect((await observe()).origin).toBe(SSA);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).not.toHaveProperty("origins");
    goTo(`${LOGIN}/sign-in`);
    await expect(observe()).rejects.toThrow(/wrong-context/);
  });

  it("binds every allowed origin of an extended task and records each page's own origin", async () => {
    const { actuator, bindings, applied, apply, observe, goTo, task } = setup();
    await observe();
    const extended = apply({
      type: "extend-origin",
      origin: LOGIN,
      checkRef: "check-1",
    });
    await actuator.scopeChanged({
      owner,
      taskId: extended.id,
      epoch: extended.epoch,
      allowedOrigins: extended.allowedOrigins,
    });
    expect(applied).toEqual([[SSA, LOGIN]]);
    goTo(`${LOGIN}/sign-in`);
    expect((await observe()).origin).toBe(LOGIN);
    goTo(`${SSA}/my-account`);
    expect((await observe()).origin).toBe(SSA);
    // One binding per epoch covers the hand-off and the return.
    expect(bindings).toHaveLength(2);
    expect(bindings[1]).toMatchObject({
      epoch: extended.epoch,
      origin: LOGIN,
      origins: [SSA, LOGIN],
    });
    expect(task().originChain?.map((step) => step.origin)).toEqual([
      SSA,
      LOGIN,
      SSA,
    ]);
    goTo("https://elsewhere.example/");
    await expect(observe()).rejects.toThrow(/wrong-context/);
  });

  it("narrows to the starting origin after a retraction", async () => {
    const { actuator, bindings, applied, apply, observe, goTo } = setup();
    await observe();
    apply({ type: "extend-origin", origin: LOGIN, checkRef: "check-1" });
    goTo(`${LOGIN}/sign-in`);
    await observe();
    goTo(`${SSA}/back`);
    const narrowed = apply({ type: "retract-origin", origin: LOGIN });
    await actuator.scopeChanged({
      owner,
      taskId: narrowed.id,
      epoch: narrowed.epoch,
      allowedOrigins: narrowed.allowedOrigins,
    });
    expect(applied).toEqual([[SSA]]);
    expect((await observe()).origin).toBe(SSA);
    expect(bindings.at(-1)).toMatchObject({
      epoch: narrowed.epoch,
      origin: SSA,
    });
    expect(bindings.at(-1)).not.toHaveProperty("origins");
    goTo(`${LOGIN}/again`);
    await expect(observe()).rejects.toThrow(/wrong-context/);
  });

  it("refuses a policy origin outside the task and a stale scope change", async () => {
    const outside = setup({ origins: [SSA, LOGIN] });
    await expect(outside.observe()).rejects.toThrow(
      /Invalid task browser policy/,
    );
    const { actuator, apply, task } = setup();
    apply({ type: "extend-origin", origin: LOGIN, checkRef: "check-1" });
    await expect(
      actuator.scopeChanged({
        owner,
        taskId: task().id,
        epoch: task().epoch - 1,
        allowedOrigins: [SSA],
      }),
    ).rejects.toThrow(/changed again/);
  });

  it("does not write an origin list replaced while guidance was being removed", async () => {
    const { actuator, applied, apply } = setup();
    const extended = apply({
      type: "extend-origin",
      origin: LOGIN,
      checkRef: "check-1",
    });
    const applying = actuator.scopeChanged({
      owner,
      taskId: extended.id,
      epoch: extended.epoch,
      allowedOrigins: extended.allowedOrigins,
    });
    // The retraction commits while this apply awaits guidance removal.
    apply({ type: "retract-origin", origin: LOGIN });
    await expect(applying).rejects.toThrow(/changed again/);
    expect(applied).toEqual([]);
  });
});
