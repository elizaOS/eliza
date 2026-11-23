import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { buildCadenceFromLlmParams } from "../life.js";
import {
  buildTaskCreatePlan,
  extractReminderIntensityWithLlm,
  extractTaskCreatePlanWithLlm,
  taskCreatePlanGuidance,
} from "./extract-task-plan.js";

describe("buildTaskCreatePlan field normalization", () => {
  it("normalizes cadence casing and window whitespace like the update path", () => {
    const plan = buildTaskCreatePlan({
      mode: "create",
      requestKind: "reminder",
      title: "Stretch",
      cadenceKind: "Weekly",
      windows: [" morning "],
      weekdays: [1, 3],
    });

    expect(plan?.cadenceKind).toBe("weekly");
    expect(plan?.windows).toEqual(["morning"]);
    if (!plan) throw new Error("expected a create plan");
    expect(buildCadenceFromLlmParams(plan)?.cadence).toEqual({
      kind: "weekly",
      weekdays: [1, 3],
      windows: ["morning"],
    });
  });

  it("keeps a padded window on create instead of falling back to morning", () => {
    const plan = buildTaskCreatePlan({
      mode: "create",
      requestKind: "reminder",
      title: "Journal",
      cadenceKind: "daily",
      windows: [" evening "],
    });

    if (!plan) throw new Error("expected a create plan");
    expect(buildCadenceFromLlmParams(plan)?.cadence).toEqual({
      kind: "daily",
      windows: ["evening"],
    });
  });
});

describe("create-plan extraction reasoning", () => {
  function recordingRuntime(outputs: string[]) {
    const calls: Array<Record<string, unknown>> = [];
    const runtime = {
      character: { name: "Agent" },
      reportError: () => undefined,
      logger: { warn: () => undefined },
      useModel: async (_type: string, params: Record<string, unknown>) => {
        calls.push(params);
        return outputs.shift() ?? "";
      },
    } as unknown as IAgentRuntime;
    return { runtime, calls };
  }

  it("asks for low reasoning on the first and repair calls", async () => {
    const { runtime, calls } = recordingRuntime([
      "not json",
      JSON.stringify({ mode: "respond", response: "When should it happen?" }),
    ]);
    const plan = await extractTaskCreatePlanWithLlm({
      runtime,
      intent: "remind me to water the plants",
      state: undefined,
      now: new Date("2026-11-20T18:15:00.000Z"),
      timeZone: "America/Los_Angeles",
    });

    expect(plan.mode).toBe("respond");
    expect(calls.map((call) => call.providerOptions)).toEqual([
      { eliza: { thinking: "low" } },
      { eliza: { thinking: "low" } },
    ]);
  });

  it("tells the model a condition alone is a one-off, not a recurrence", async () => {
    const { runtime, calls } = recordingRuntime([
      JSON.stringify({ mode: "respond", response: "What time?" }),
    ]);
    await extractTaskCreatePlanWithLlm({
      runtime,
      intent: "if the package is late, remind me to call the seller",
      state: undefined,
      now: new Date("2026-11-20T18:15:00.000Z"),
      timeZone: "America/Los_Angeles",
    });

    expect(calls).toHaveLength(1);
    expect(String(calls[0].prompt)).toContain(
      'A condition ("if ...", "unless ...") is not a recurrence: without a recurrence word, the reminder happens once.',
    );
    expect(taskCreatePlanGuidance(true)).not.toContain("is not a recurrence");
  });

  it("leaves the other extractors in this module without a reasoning hint", async () => {
    const { runtime, calls } = recordingRuntime(['{"intensity":"minimal"}']);
    await extractReminderIntensityWithLlm({
      runtime,
      intent: "fewer reminders",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("providerOptions");
  });
});
