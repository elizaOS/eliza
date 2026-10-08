import {
  createInteractiveTask,
  type TaskActionProposal,
  transitionInteractiveTask,
} from "@elizaos/core/protocol";
import { expect, it } from "vitest";
import { NativeTaskActuator } from "./task-actuator.js";

const owner = {
  actorId: "actor",
  agentId: "agent",
  connector: { source: "test", accountId: "account" },
};
function setup(
  capability = "browser.click",
  resolveValue: ConstructorParameters<
    typeof NativeTaskActuator
  >[0]["resolveValue"] = async () => "value",
  guideTask?: NonNullable<
    ConstructorParameters<typeof NativeTaskActuator>[0]["target"]["guideTask"]
  >,
  reconcile?: ConstructorParameters<typeof NativeTaskActuator>[0]["reconcile"],
  assistantName?: string,
) {
  let task = createInteractiveTask({
    id: "task",
    owner,
    goalRef: "goal",
    authorization: {
      decisionId: "grant",
      policyRevision: "policy",
      state: "active",
      decidedAt: new Date().toISOString(),
      revokedAt: null,
    },
    allowedCapabilities: [capability],
    allowedOrigins: ["https://example.test"],
    now: Date.now(),
  });
  const protectedKinds: Array<string | undefined> = [];
  const targetCounts: number[] = [];
  const assistantNames: Array<string | undefined> = [];
  let sequence = 0,
    effects = 0,
    bindings = 0;
  const transition = (
    event: Parameters<typeof transitionInteractiveTask>[2],
  ) => {
    task = transitionInteractiveTask(
      task,
      { owner, expectedRevision: task.revision, now: Date.now() },
      event,
    ).task;
  };
  const actuator = new NativeTaskActuator({
    assistantName,
    getTask: () => task,
    reconcile,
    nextBindingRevision: () => ++bindings,
    policy: () => ({
      tabId: "1",
      origin: "https://example.test",
      leaseMs: 60000,
      targets: [
        {
          selector: "#target",
          action: capability === "browser.click" ? "click" : "fill",
        },
      ],
    }),
    target: {
      guideTask: guideTask || (async () => ({ visible: false })),
      bindTask: async (binding) => {
        targetCounts.push(binding.targets.length);
        assistantNames.push(binding.assistantName);
        return {
          bound: true,
          tabId: binding.tabId,
          taskId: binding.taskId,
          epoch: binding.epoch,
          bindingRevision: binding.bindingRevision,
        };
      },
      execute: async (command, options) => {
        expect(options?.taskContext?.taskId).toBe(task.id);
        expect(options?.taskContext?.epoch).toBe(task.epoch);
        if (command.subaction !== "snapshot") {
          expect(options?.taskExpiresAt).toBeGreaterThan(Date.now());
          effects++;
          protectedKinds.push(options?.protectedValueKind);
        }
        const id = `00000000-0000-0000-0000-${String(++sequence).padStart(12, "0")}`;
        return {
          targetId: "test",
          mode: "desktop",
          subaction: command.subaction,
          value: {
            result:
              command.subaction === "snapshot"
                ? {
                    snapshotId: id,
                    frames: [
                      {
                        frameId: 0,
                        documentId: "document",
                        url: "https://example.test/",
                        complete: true,
                        inputRevision: 0,
                        text: `effects:${effects}`,
                        elements: [{ selector: `${id}:0:0` }],
                      },
                    ],
                  }
                : {
                    dispatched: true,
                    completed: false,
                    requiresReadback: true,
                  },
          },
        };
      },
    },
    resolveValue,
    verify: async (_proposal, before, after) =>
      before.text === "effects:0" && after.text === "effects:1"
        ? "succeeded"
        : "unknown",
    recordEvidence: async (_task, _proposal, _before, _after, status) => {
      expect(status).toBe("succeeded");
      return "evidence:observed-change";
    },
  });
  const prepare = async () => {
    const observation = await actuator.observe({
      owner,
      taskId: task.id,
      signal: new AbortController().signal,
    });
    transition({ type: "observe", observation });
    const proposal: TaskActionProposal = {
      id: "operation",
      taskId: task.id,
      epoch: task.epoch,
      observationId: observation.id,
      observationVersion: observation.version,
      inputRevision: observation.inputRevision,
      targetRef: `${observation.id}:0:0`,
      capability,
      authorizationId: "grant",
      expiresAt: Date.now() + 60000,
      ...(capability === "browser.fill" ? { valueRef: "protected:value" } : {}),
    };
    transition({ type: "prepare", proposal });
    transition({ type: "dispatch", operationId: proposal.id });
    return proposal;
  };
  return {
    actuator,
    protectedKinds,
    targetCounts,
    assistantNames,
    prepare,
    transition,
    get task() {
      return task;
    },
    get effects() {
      return effects;
    },
    get bindings() {
      return bindings;
    },
  };
}

it("binds the core task to a native observation and verifies actual readback before success", async () => {
  const f = setup();
  const proposal = await f.prepare();
  expect(f.actuator.readObservation("task", owner).snapshot.text).toBe(
    "effects:0",
  );
  const result = await f.actuator.execute(proposal, {
    owner,
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  expect(result).toEqual({
    status: "succeeded",
    evidenceRef: "evidence:observed-change",
  });
  expect(f.effects).toBe(1);
  expect(f.bindings).toBe(1);
  await expect(
    f.actuator.execute(proposal, {
      owner,
      signal: new AbortController().signal,
      isCurrent: () => true,
    }),
  ).rejects.toThrow();
  expect(f.effects).toBe(1);
});

it("pausing during protected value resolution prevents dispatch", async () => {
  let release: (value: string) => void = () => {};
  let entered: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = setup("browser.fill", () => {
    entered();
    return new Promise<string>((resolve) => {
      release = resolve;
    });
  });
  const proposal = await f.prepare();
  const result = f.actuator.execute(proposal, {
    owner,
    signal: new AbortController().signal,
    isCurrent: () => f.task.status === "waiting",
  });
  const rejected = expect(result).rejects.toThrow();
  await waiting;
  f.transition({ type: "pause" });
  release("value");
  await rejected;
  expect(f.effects).toBe(0);
});

it("wrong-account observations are rejected before contacting the browser", async () => {
  const f = setup();
  await expect(
    f.actuator.observe({
      owner: { ...owner, actorId: "other" },
      taskId: "task",
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow();
  expect(f.bindings).toBe(0);
  expect(f.effects).toBe(0);
});

it("task guidance is observed, owner-bound and removable after pause", async () => {
  const requests: Array<{ kind: string; revision: number }> = [];
  let rejectHide = false;
  const f = setup(
    "browser.click",
    async () => "value",
    async (request) => {
      requests.push(request);
      return request.kind === "show"
        ? { accepted: true }
        : rejectHide
          ? {}
          : { visible: false };
    },
  );
  const observation = await f.actuator.observe({
    owner,
    taskId: "task",
    signal: new AbortController().signal,
  });
  f.transition({ type: "observe", observation });
  await f.actuator.showGuidance(
    "task",
    owner,
    {
      stepId: "step",
      targetRef: `${observation.id}:0:0`,
      text: "Continue here",
    },
    new AbortController().signal,
  );
  f.transition({ type: "pause" });
  rejectHide = true;
  await expect(f.actuator.quiesce({ owner, taskId: "task" })).rejects.toThrow(
    /not acknowledged/,
  );
  await expect(
    f.actuator.quiesce({
      owner: { ...owner, actorId: "other" },
      taskId: "task",
    }),
  ).rejects.toThrow(/owner/);
  rejectHide = false;
  await f.actuator.quiesce({ owner, taskId: "task" });
  expect(requests.map((r) => r.kind)).toEqual(["show", "hide", "hide"]);
  expect(requests.map((r) => r.revision)).toEqual([1, 2, 3]);
  expect(f.effects).toBe(0);
});

it("requires acknowledged feedback cleanup before any effect and after dispatch", async () => {
  const denied = setup(
    "browser.click",
    async () => "value",
    async () => ({}),
  );
  await expect(
    denied.actuator.execute(await denied.prepare(), {
      owner,
      signal: new AbortController().signal,
      isCurrent: () => true,
    }),
  ).rejects.toThrow(/not acknowledged/);
  expect(denied.effects).toBe(0);
  let calls = 0;
  const uncertain = setup(
    "browser.click",
    async () => "value",
    async () => (++calls === 1 ? { visible: false } : {}),
  );
  await expect(
    uncertain.actuator.execute(await uncertain.prepare(), {
      owner,
      signal: new AbortController().signal,
      isCurrent: () => true,
    }),
  ).rejects.toThrow(/not acknowledged/);
  expect(uncertain.effects).toBe(1);
});

it("only a protected resolver result marks an OTP fill", async () => {
  const f = setup("browser.fill", async () => ({
    kind: "verification-code",
    text: "123456",
  }));
  const proposal = await f.prepare();
  const result = await f.actuator.execute(proposal, {
    owner,
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  expect(result.status).toBe("succeeded");
  expect(f.protectedKinds).toEqual(["verification-code"]);
});

it("rejects malformed protected values before effects", async () => {
  const f = setup("browser.fill", async () => ({
    kind: "verification-code",
    text: "not a code",
  }));
  const proposal = await f.prepare();
  await expect(
    f.actuator.execute(proposal, {
      owner,
      signal: new AbortController().signal,
      isCurrent: () => true,
    }),
  ).rejects.toMatchObject({ code: "TASK_ACTION_DENIED" });
  expect(f.effects).toBe(0);
});

it("reconciles through a fresh read-only binding without dispatch or reusable observation", async () => {
  let reads = 0;
  const f = setup(
    "browser.click",
    undefined,
    undefined,
    async (_task, _proposal, snapshot) => {
      reads++;
      expect(snapshot.text).toBe("effects:0");
      return { status: "failed", evidenceRef: "fresh-readback" };
    },
  );
  const proposal = await f.prepare();
  f.transition({ type: "pause" });
  const result = await f.actuator.reconcile(proposal, {
    owner,
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  expect(result).toEqual({ status: "failed", evidenceRef: "fresh-readback" });
  expect(f.targetCounts).toEqual([1, 0]);
  expect(f.effects).toBe(0);
  expect(reads).toBe(1);
  expect(() => f.actuator.readObservation("task", owner)).toThrow();
  expect(f.task.status).toBe("paused");
  expect(f.task.operations[0].status).toBe("unknown");
});

it("rejects stale readback before binding or interpreting a snapshot", async () => {
  let reads = 0;
  const f = setup("browser.click", undefined, undefined, async () => {
    reads++;
    return { status: "unknown" };
  });
  const proposal = await f.prepare();
  f.transition({ type: "pause" });
  await expect(
    f.actuator.reconcile(proposal, {
      owner,
      signal: new AbortController().signal,
      isCurrent: () => false,
    }),
  ).rejects.toThrow();
  expect(f.targetCounts).toEqual([1]);
  expect(f.effects).toBe(0);
  expect(reads).toBe(0);
});

it("passes label words, offers and the configured name, and pauses before removal", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const f = setup(
    "browser.click",
    async () => "value",
    async (request) => {
      requests.push(request);
      return request.kind === "show" ? { accepted: true } : { visible: false };
    },
    undefined,
    "Grace",
  );
  const observation = await f.actuator.observe({
    owner,
    taskId: "task",
    signal: new AbortController().signal,
  });
  f.transition({ type: "observe", observation });
  expect(f.assistantNames).toEqual(["Grace"]);
  const answers = [
    { id: "yes", kind: "primary" as const, text: "Yes" },
    { id: "type", kind: "secondary" as const, text: "I'll type it" },
  ];
  await expect(
    f.actuator.showGuidance(
      "task",
      owner,
      {
        stepId: "email",
        targetRef: `${observation.id}:0:0`,
        text: "Use your email?",
        detail: "From your profile.",
        tone: "offer",
        answers,
      },
      new AbortController().signal,
    ),
  ).resolves.toEqual({ tabId: "1", revision: 1 });
  expect(requests[0]).toMatchObject({
    kind: "show",
    detail: "From your profile.",
    tone: "offer",
    answers,
  });
  await expect(
    f.actuator.pauseGuidance({
      owner: { ...owner, actorId: "other" },
      taskId: "task",
    }),
  ).rejects.toThrow(/owner/);
  f.transition({ type: "pause" });
  await f.actuator.pauseGuidance({ owner, taskId: "task" });
  await f.actuator.quiesce({ owner, taskId: "task" });
  expect(requests.map((r) => [r.kind, r.revision])).toEqual([
    ["show", 1],
    ["pause", 2],
    ["hide", 3],
  ]);
  expect(f.effects).toBe(0);
});
