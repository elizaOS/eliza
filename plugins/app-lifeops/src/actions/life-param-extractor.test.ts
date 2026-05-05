import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  extractReminderIntensityWithLlm,
  extractTaskCreatePlanWithLlm,
} from "./life-param-extractor.js";

describe("extractTaskCreatePlanWithLlm", () => {
  it("returns the empty plan when intent is empty", async () => {
    const useModel = vi.fn();
    const plan = await extractTaskCreatePlanWithLlm({
      runtime: { useModel } as unknown as IAgentRuntime,
      intent: "   ",
      state: undefined,
    });

    expect(plan.mode).toBe("respond");
    expect(plan.title).toBeNull();
    expect(useModel).not.toHaveBeenCalled();
  });

  it("returns the empty plan when runtime.useModel is unavailable", async () => {
    const plan = await extractTaskCreatePlanWithLlm({
      runtime: {} as IAgentRuntime,
      intent: "remind me to brush teeth morning and night",
      state: undefined,
    });

    expect(plan.mode).toBe("respond");
    expect(plan.title).toBeNull();
  });

  it("parses a valid first-pass create plan", async () => {
    const useModel = vi.fn(async () =>
      JSON.stringify({
        mode: "create",
        response: null,
        requestKind: "reminder",
        title: "Brush teeth",
        description: null,
        cadenceKind: "daily",
        windows: ["morning", "night"],
        weekdays: null,
        timeOfDay: null,
        everyMinutes: null,
        timesPerDay: null,
        priority: null,
        durationMinutes: null,
      }),
    );

    const plan = await extractTaskCreatePlanWithLlm({
      runtime: { useModel } as unknown as IAgentRuntime,
      intent: "remind me to brush teeth morning and night",
      state: undefined,
    });

    expect(plan.mode).toBe("create");
    expect(plan.title).toBe("Brush teeth");
    expect(plan.cadenceKind).toBe("daily");
    expect(plan.windows).toEqual(["morning", "night"]);
    expect(useModel).toHaveBeenCalledTimes(1);
  });

  it("issues a repair pass when the first response is unparseable", async () => {
    const calls: string[] = [];
    const useModel = vi.fn(async (_type: string, opts: { prompt: string }) => {
      calls.push(opts.prompt);
      return calls.length === 1
        ? "still thinking..."
        : JSON.stringify({
            mode: "respond",
            response: "What should I track?",
          });
    });

    const plan = await extractTaskCreatePlanWithLlm({
      runtime: { useModel } as unknown as IAgentRuntime,
      intent: "remind me about something",
      state: undefined,
    });

    expect(plan.mode).toBe("respond");
    expect(plan.response).toBe("What should I track?");
    expect(useModel).toHaveBeenCalledTimes(2);
    expect(calls[1]).toContain(
      "Your last reply for the LifeOps create-definition planner was invalid",
    );
  });
});

describe("extractReminderIntensityWithLlm", () => {
  it("returns 'unknown' when runtime.useModel is unavailable", async () => {
    const plan = await extractReminderIntensityWithLlm({
      runtime: {} as IAgentRuntime,
      intent: "less reminders please",
    });

    expect(plan.intensity).toBe("unknown");
  });

  it("accepts a bare-keyword first-pass response", async () => {
    const useModel = vi.fn(async () => "minimal");
    const plan = await extractReminderIntensityWithLlm({
      runtime: { useModel } as unknown as IAgentRuntime,
      intent: "less reminders please",
    });

    expect(plan.intensity).toBe("minimal");
    expect(useModel).toHaveBeenCalledTimes(1);
  });

  it("issues a repair pass when the first response is unparseable", async () => {
    const calls: string[] = [];
    const useModel = vi.fn(async (_type: string, opts: { prompt: string }) => {
      calls.push(opts.prompt);
      return calls.length === 1 ? "uhh maybe" : '{"intensity":"persistent"}';
    });

    const plan = await extractReminderIntensityWithLlm({
      runtime: { useModel } as unknown as IAgentRuntime,
      intent: "more reminders",
    });

    expect(plan.intensity).toBe("persistent");
    expect(useModel).toHaveBeenCalledTimes(2);
    expect(calls[1]).toContain(
      "Your last reply for the LifeOps reminder-intensity extractor was invalid",
    );
  });
});
