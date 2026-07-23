/**
 * Contributed dispatch channels: registry semantics (per-runtime isolation,
 * duplicate rejection) and end-to-end routing through the REAL
 * ScheduledTaskRunnerService — a task whose escalation step names a
 * contributed channel dispatches through the contribution, everything else
 * stays on the host/default dispatcher, and late registration (after the
 * cached runner was built) is still honored.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  getScheduledTaskChannelDispatcher,
  listScheduledTaskChannelDispatcherKeys,
  registerScheduledTaskChannelDispatcher,
} from "./channel-dispatcher-registry.js";
import type { ScheduledTaskDispatchRecord } from "./runner.js";
import { ScheduledTaskRunnerService } from "./runner-service.js";

function makeFakeRuntime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-00000000d15b",
    getService: () => null,
    // The default dispatcher model-renders promptInstructions; a deterministic
    // stub keeps non-contributed fires succeeding.
    useModel: async () => "Rendered dispatch message.",
    reportError: () => undefined,
  } as unknown as IAgentRuntime;
}

describe("channel-dispatcher registry", () => {
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
