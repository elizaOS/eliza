/**
 * Honest in_app dispatch results (#10721 audit item 5 / QA 4.9).
 *
 * The production dispatcher's in_app branch returned ok:true
 * unconditionally — even on hosts where BOTH surfaces (assistant event bus,
 * notification service) were absent — fabricating delivery so the dispatch
 * policy never retried or escalated. It must report ok:false when nothing
 * accepted the payload, and count a notification-service write as real
 * delivery.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createProductionScheduledTaskDispatcher } from "../src/lifeops/scheduled-task/runtime-wiring.ts";

// Deterministic model output: the dispatcher renders `promptInstructions`
// through the model before any surface, so assertions target this text.
const RENDERED_BODY = "Time for a glass of water.";

function makeRuntime(args: {
  notifier?: { notify: (input: unknown) => Promise<unknown> } | null;
}): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-0000000000aa",
    getService: (type: string) => {
      if (type === "notification") return args.notifier ?? null;
      return null;
    },
    getSetting: () => null,
    useModel: async () => RENDERED_BODY,
    reportError: () => undefined,
  } as unknown as IAgentRuntime;
}

function inAppRecord() {
  return {
    taskId: "st_test_inapp",
    firedAtIso: "2026-07-01T12:00:00.000Z",
    channelKey: "in_app",
    intensity: "normal" as const,
    promptInstructions: "Remind the owner to drink a glass of water.",
    contextRequest: undefined,
    output: undefined,
    metadata: undefined,
  };
}

describe("production dispatcher in_app honesty", () => {
  it("returns ok:false when neither the event bus nor the notification service exists", async () => {
    const dispatcher = createProductionScheduledTaskDispatcher({
      runtime: makeRuntime({ notifier: null }),
    });
    const result = await dispatcher.dispatch(inAppRecord());
    expect(result).toMatchObject({ ok: false, reason: "disconnected" });
  });

  it("returns ok:true when the notification service accepts the payload", async () => {
    const notify = vi.fn(async () => ({ id: "n1" }));
    const dispatcher = createProductionScheduledTaskDispatcher({
      runtime: makeRuntime({ notifier: { notify } }),
    });
    const result = await dispatcher.dispatch(inAppRecord());
    expect(result).toMatchObject({ ok: true });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        body: RENDERED_BODY,
        category: "reminder",
        groupKey: "lifeops:st_test_inapp",
      }),
    );
  });

  it("a throwing notification service with no event bus is a failed dispatch, not fabricated success", async () => {
    const notify = vi.fn(async () => {
      throw new Error("inbox store down");
    });
    const dispatcher = createProductionScheduledTaskDispatcher({
      runtime: makeRuntime({ notifier: { notify } }),
    });
    const result = await dispatcher.dispatch(inAppRecord());
    expect(result).toMatchObject({ ok: false, reason: "disconnected" });
  });

  it("urgent intensity maps to the approval category", async () => {
    const notify = vi.fn(async () => ({ id: "n2" }));
    const dispatcher = createProductionScheduledTaskDispatcher({
      runtime: makeRuntime({ notifier: { notify } }),
    });
    await dispatcher.dispatch({ ...inAppRecord(), intensity: "urgent" });
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ category: "approval", priority: "urgent" }),
    );
  });
});
