/**
 * ScheduledTaskRunnerService clock tests (#10721 frozen-clock).
 *
 * Before the fix, `getRunner` cached by `agentId + "::now-override"`, so the
 * FIRST tick's `now` closure was baked into the cached runner forever: every
 * later fire stamped `firedAt` with the boot tick's instant, completion
 * timeouts became instantly due once uptime exceeded `followupAfterMinutes`,
 * and quiet-hours/weekend gates evaluated the boot instant forever.
 *
 * The service now caches ONE runner per agent that reads through a mutable
 * clock ref rebound on every `getRunner` call.
 *
 * Also covers the runner host's dispatcher wrapping: the built-in
 * coding-agent channel and the contributed dispatch-channel registry
 * (registry semantics, per-dispatch routing through the REAL runner, typed
 * failure driving the dispatch policy, and delegation for other channels).
 */

import { type IAgentRuntime, isElizaError, ServiceType } from "@elizaos/core";
import { describe, expect, it } from "vitest";

import {
  buildPrShepherdScheduleInput,
  GITHUB_PR_SHEPHERD_SERVICE_TYPE,
  ORCHESTRATOR_TASK_SERVICE_TYPE,
  PR_SHEPHERD_DISPATCH_CHANNEL,
} from "../coding-agent-schedules.js";
import {
  getScheduledTaskChannelDispatcher,
  listScheduledTaskChannelDispatcherKeys,
  registerScheduledTaskChannelDispatcher,
} from "./channel-dispatcher-registry.js";
import type { ScheduledTaskDispatchRecord } from "./runner.js";
import {
  getScheduledTaskRunner,
  ScheduledTaskRunnerService,
} from "./runner-service.js";

it("exposes a typed unavailable error when the runner service is absent", () => {
  const runtime = {
    getService: () => null,
  } as unknown as IAgentRuntime;

  expect(() =>
    getScheduledTaskRunner(runtime, {
      agentId: "00000000-0000-0000-0000-00000000cafe",
    }),
  ).toThrow(
    expect.objectContaining({ code: "SCHEDULED_TASK_RUNNER_UNAVAILABLE" }),
  );
});

function makeFakeRuntime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-00000000cafe",
    getService: (type: string) =>
      type === ServiceType.NOTIFICATION
        ? { notify: async () => undefined }
        : null,
    // The default dispatcher renders promptInstructions through the model
    // before notifying; a deterministic stub keeps fires succeeding so the
    // assertions below stay about the clock.
    useModel: async () => "Rendered dispatch message.",
    reportError: () => undefined,
  } as unknown as IAgentRuntime;
}

describe("ScheduledTaskRunnerService — rebindable tick clock", () => {
  it("caches one runner per agent and rebinds the clock on every getRunner call", async () => {
    const runtime = makeFakeRuntime();
    const service = await ScheduledTaskRunnerService.start(runtime);
    const agentId = runtime.agentId;

    const tick1 = new Date("2026-05-09T12:00:00.000Z");
    const runner1 = service.getRunner({ agentId, now: () => tick1 });
    const taskA = await runner1.schedule({
      kind: "reminder",
      promptInstructions: "task A",
      trigger: { kind: "once", atIso: "2026-05-09T11:59:00.000Z" },
      priority: "medium",
      respectsGlobalPause: false,
      source: "user_chat",
      createdBy: agentId,
      ownerVisible: true,
    });
    const firedA = await runner1.fire(taskA.taskId);
    expect(firedA.state.firedAt).toBe(tick1.toISOString());

    // Second tick at a LATER time gets the SAME cached runner (state — the
    // in-memory store — is preserved) but the rebound clock, so the fire
    // stamps the SECOND tick's instant, not the boot tick's.
    const tick2 = new Date("2026-05-09T13:30:00.000Z");
    const runner2 = service.getRunner({ agentId, now: () => tick2 });
    expect(runner2).toBe(runner1);
    const taskB = await runner2.schedule({
      kind: "reminder",
      promptInstructions: "task B",
      trigger: { kind: "once", atIso: "2026-05-09T13:29:00.000Z" },
      priority: "medium",
      respectsGlobalPause: false,
      source: "user_chat",
      createdBy: agentId,
      ownerVisible: true,
    });
    const firedB = await runner2.fire(taskB.taskId);
    expect(firedB.state.firedAt).toBe(tick2.toISOString());
    // Task A's earlier fire is untouched by the rebind.
    const persistedA = await runner2.list();
    expect(
      persistedA.find((t) => t.taskId === taskA.taskId)?.state.firedAt,
    ).toBe(tick1.toISOString());
  });

  it("a getRunner call without an override rebinds back to the system clock", async () => {
    const runtime = makeFakeRuntime();
    const service = await ScheduledTaskRunnerService.start(runtime);
    const agentId = runtime.agentId;

    const frozen = new Date("2020-01-01T00:00:00.000Z");
    service.getRunner({ agentId, now: () => frozen });
    const runner = service.getRunner({ agentId });

    const before = Date.now();
    const task = await runner.schedule({
      kind: "reminder",
      promptInstructions: "system clock task",
      trigger: { kind: "manual" },
      priority: "medium",
      respectsGlobalPause: false,
      source: "user_chat",
      createdBy: agentId,
      ownerVisible: true,
    });
    const fired = await runner.fire(task.taskId);
    const after = Date.now();
    const firedAtMs = Date.parse(fired.state.firedAt ?? "");
    expect(firedAtMs).toBeGreaterThanOrEqual(before);
    expect(firedAtMs).toBeLessThanOrEqual(after);
  });

  it("wraps the runner dispatcher with coding-agent schedule handling", async () => {
    const createdTasks: Array<{
      title: string;
      metadata?: Record<string, unknown>;
    }> = [];
    const runtime = {
      ...makeFakeRuntime(),
      getService(type: string) {
        if (type === GITHUB_PR_SHEPHERD_SERVICE_TYPE) {
          return {
            async listAssignedOpenPullRequests() {
              return [
                {
                  owner: "elizaOS",
                  repo: "eliza",
                  number: 16455,
                  title: "Needs PR shepherd",
                  url: "https://github.com/elizaOS/eliza/pull/16455",
                  reviewDecision: "CHANGES_REQUESTED",
                  behindBase: false,
                  checksConclusion: "success",
                },
              ];
            },
          };
        }
        if (type === ORCHESTRATOR_TASK_SERVICE_TYPE) {
          return {
            async createTask(input: {
              title: string;
              metadata?: Record<string, unknown>;
            }) {
              createdTasks.push(input);
              return { id: "coding-task-1", metadata: input.metadata };
            },
            async listTasks() {
              return [];
            },
          };
        }
        return null;
      },
    } as unknown as IAgentRuntime;
    const service = await ScheduledTaskRunnerService.start(runtime);
    const runner = service.getRunner({
      agentId: runtime.agentId,
      now: () => new Date("2026-07-17T12:00:00.000Z"),
    });
    const schedule = await runner.schedule(
      buildPrShepherdScheduleInput({
        agentId: runtime.agentId,
        trigger: { kind: "manual" },
        projectId: "project-a",
      }),
    );

    const result = await runner.fireWithResult(schedule.taskId);

    expect(result.kind).toBe("fired");
    expect(createdTasks).toHaveLength(1);
    expect(createdTasks[0]?.title).toBe("PR shepherd: elizaOS/eliza#16455");
    expect(createdTasks[0]?.metadata?.mergeDisabled).toBe(true);
  });
});

describe("contributed dispatch channels — registry semantics + runner routing", () => {
  it("registers, resolves, and lists per runtime; other runtimes see nothing", () => {
    const runtimeA = makeFakeRuntime();
    const runtimeB = makeFakeRuntime();
    registerScheduledTaskChannelDispatcher(runtimeA, {
      channelKey: "test_channel",
      dispatch: async () => ({ ok: true }),
    });
    expect(
      getScheduledTaskChannelDispatcher(runtimeA, "test_channel"),
    ).not.toBeNull();
    expect(getScheduledTaskChannelDispatcher(runtimeB, "test_channel")).toBe(
      null,
    );
    expect(listScheduledTaskChannelDispatcherKeys(runtimeA)).toEqual([
      "test_channel",
    ]);
    expect(listScheduledTaskChannelDispatcherKeys(runtimeB)).toEqual([]);
  });

  it("rejects duplicate channel keys and malformed contributions", () => {
    const runtime = makeFakeRuntime();
    registerScheduledTaskChannelDispatcher(runtime, {
      channelKey: "dup_channel",
      dispatch: async () => undefined,
    });
    expect(() =>
      registerScheduledTaskChannelDispatcher(runtime, {
        channelKey: "dup_channel",
        dispatch: async () => undefined,
      }),
    ).toThrow(/duplicate channel "dup_channel"/);
    expect(() =>
      registerScheduledTaskChannelDispatcher(runtime, {
        channelKey: "",
        dispatch: async () => undefined,
      }),
    ).toThrow(/channelKey required/);
    expect(() =>
      registerScheduledTaskChannelDispatcher(runtime, {
        channelKey: "no_dispatch",
        // @ts-expect-error deliberately malformed
        dispatch: null,
      }),
    ).toThrow(/dispatch function required/);
  });

  it("rejects reserved/built-in channel keys so a contribution cannot hijack them", () => {
    // Contributed lookup runs BEFORE the built-in channels at dispatch time,
    // so without this guard a registration under the pr-shepherd channel or a
    // host connector kind would silently reroute that channel's dispatches.
    const runtime = makeFakeRuntime();
    let thrown: unknown;
    try {
      registerScheduledTaskChannelDispatcher(runtime, {
        channelKey: PR_SHEPHERD_DISPATCH_CHANNEL,
        dispatch: async () => ({ ok: true }),
      });
    } catch (error) {
      thrown = error;
    }
    expect(isElizaError(thrown)).toBe(true);
    if (!isElizaError(thrown)) throw new Error("expected ElizaError");
    expect(thrown.code).toBe("SCHEDULED_TASK_CHANNEL_KEY_RESERVED");
    expect(thrown.message).toContain(PR_SHEPHERD_DISPATCH_CHANNEL);
    expect(thrown.message).toContain("reserved");

    for (const hostKey of ["imessage", "in_app", "telegram"]) {
      expect(() =>
        registerScheduledTaskChannelDispatcher(runtime, {
          channelKey: hostKey,
          dispatch: async () => ({ ok: true }),
        }),
      ).toThrow(/reserved for a built-in dispatch channel/);
    }

    // Nothing leaked into the registry — built-in routing stays untouched.
    expect(
      getScheduledTaskChannelDispatcher(runtime, PR_SHEPHERD_DISPATCH_CHANNEL),
    ).toBeNull();
    expect(listScheduledTaskChannelDispatcherKeys(runtime)).toEqual([]);
  });

  it("routes fires on a contributed channel to the contribution — including registrations made after the runner was built", async () => {
    const runtime = makeFakeRuntime();
    const service = await ScheduledTaskRunnerService.start(runtime);
    const agentId = runtime.agentId;
    const runner = service.getRunner({ agentId });

    // Register AFTER the cached runner exists — lookup is per-dispatch.
    const dispatched: ScheduledTaskDispatchRecord[] = [];
    registerScheduledTaskChannelDispatcher(runtime, {
      channelKey: "late_contributed_channel",
      dispatch: async (record) => {
        dispatched.push(record);
        return { ok: true, messageId: `contributed:${record.taskId}` };
      },
    });

    const task = await runner.schedule({
      kind: "watcher",
      promptInstructions:
        "Structural recipe task; this text is never dispatched.",
      trigger: { kind: "manual" },
      priority: "low",
      escalation: {
        steps: [{ delayMinutes: 0, channelKey: "late_contributed_channel" }],
      },
      respectsGlobalPause: false,
      source: "plugin",
      createdBy: agentId,
      ownerVisible: false,
    });
    const fired = await runner.fire(task.taskId);
    expect(fired.state.status).toBe("fired");
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.channelKey).toBe("late_contributed_channel");
    expect(fired.metadata?.lastDispatchResult).toMatchObject({
      ok: true,
      messageId: `contributed:${task.taskId}`,
    });
  });

  it("a typed failure from a contributed dispatcher drives the runner's dispatch policy (retry, not fake-fired)", async () => {
    const runtime = makeFakeRuntime();
    const service = await ScheduledTaskRunnerService.start(runtime);
    const agentId = runtime.agentId;
    const runner = service.getRunner({ agentId });

    registerScheduledTaskChannelDispatcher(runtime, {
      channelKey: "failing_contributed_channel",
      dispatch: async () => ({
        ok: false,
        reason: "transport_error",
        userActionable: false,
        retryAfterMinutes: 5,
        message: "upstream balance source unavailable",
      }),
    });

    const task = await runner.schedule({
      kind: "watcher",
      promptInstructions: "Structural recipe task.",
      trigger: { kind: "manual" },
      priority: "low",
      escalation: {
        steps: [{ delayMinutes: 0, channelKey: "failing_contributed_channel" }],
      },
      respectsGlobalPause: false,
      source: "plugin",
      createdBy: agentId,
      ownerVisible: false,
    });
    const outcome = await runner.fireWithResult(task.taskId);
    // The dispatch policy parks the row for a same-step retry — the fire is
    // NOT recorded as a successful send.
    expect(outcome.kind).toBe("dispatch_deferred");
  });

  it("leaves non-contributed channels on the default dispatcher path", async () => {
    const runtime = makeFakeRuntime();
    const service = await ScheduledTaskRunnerService.start(runtime);
    const agentId = runtime.agentId;
    const runner = service.getRunner({ agentId });

    registerScheduledTaskChannelDispatcher(runtime, {
      channelKey: "unused_channel",
      dispatch: async () => {
        throw new Error("must not be called for other channels");
      },
    });

    const task = await runner.schedule({
      kind: "reminder",
      promptInstructions: "Remind the owner to stretch.",
      trigger: { kind: "manual" },
      priority: "medium",
      respectsGlobalPause: false,
      source: "user_chat",
      createdBy: agentId,
      ownerVisible: true,
    });
    const fired = await runner.fire(task.taskId);
    // Default in_app dispatcher (model-render stub) handled it.
    expect(fired.state.status).toBe("fired");
    expect(fired.metadata?.lastDispatchResult).toMatchObject({ ok: true });
  });
});
