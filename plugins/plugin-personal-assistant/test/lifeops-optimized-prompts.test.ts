/**
 * Covers optimized-prompt routing in LifeOps: swapping schedule_plan and reminder_dispatch
 * instructions while preserving their scheduling/reminder context. Deterministic.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { LifeOpsService } from "../src/lifeops/service.js";

const ReminderService = LifeOpsService;

function userMessage(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000201",
    entityId: "00000000-0000-0000-0000-000000000202",
    roomId: "00000000-0000-0000-0000-000000000203",
    content: { text },
  } as unknown as Memory;
}

function optimizedPromptRuntime(args: {
  task: string;
  optimizedPrompt: string;
  modelResponses: string[];
  capturedPrompts: string[];
}): IAgentRuntime {
  let callIndex = 0;
  return {
    agentId: "00000000-0000-0000-0000-000000000204",
    character: { name: "Eliza", settings: {} },
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
    getService: (name: string) =>
      name === "optimized_prompt"
        ? {
            getPrompt: (task: string) =>
              task === args.task
                ? {
                    prompt: args.optimizedPrompt,
                    optimizerSource: "gepa",
                  }
                : null,
          }
        : null,
    getMemories: vi.fn(async () => []),
    useModel: vi.fn(
      async (_modelType: unknown, params: { prompt?: string }) => {
        args.capturedPrompts.push(String(params.prompt ?? ""));
        const response =
          args.modelResponses[
            Math.min(callIndex, args.modelResponses.length - 1)
          ] ?? "";
        callIndex += 1;
        return response;
      },
    ),
  } as unknown as IAgentRuntime;
}

describe("LifeOps optimized prompt routing", () => {
  it("swaps schedule_plan instructions while preserving scheduling context", async () => {
    const { runSchedulingNegotiationHandler } = await import(
      "../src/actions/lib/scheduling-handler.js"
    );
    const capturedPrompts: string[] = [];
    const runtime = optimizedPromptRuntime({
      task: "schedule_plan",
      optimizedPrompt: "OPTIMIZED SCHEDULE: decide the negotiation route.",
      modelResponses: [
        JSON.stringify({
          subaction: null,
          shouldAct: false,
          response: "Which scheduling negotiation step should I take?",
        }),
        "Which scheduling negotiation step should I take?",
      ],
      capturedPrompts,
    });

    await runSchedulingNegotiationHandler(
      runtime,
      userMessage("Start a scheduling thread with Mia for next week"),
      undefined,
      { parameters: {} },
    );

    expect(capturedPrompts[0]).toContain(
      "OPTIMIZED SCHEDULE: decide the negotiation route.",
    );
    expect(capturedPrompts[0]).not.toContain(
      "Plan the scheduling negotiation action",
    );
    expect(capturedPrompts[0]).toContain(
      "Start a scheduling thread with Mia for next week",
    );
    expect(capturedPrompts[0]).toContain("Structured parameters:");
  });

  it("swaps reminder_dispatch instructions while preserving reminder context", async () => {
    const capturedPrompts: string[] = [];
    const runtime = optimizedPromptRuntime({
      task: "reminder_dispatch",
      optimizedPrompt: "OPTIMIZED REMINDER: write a crisp owner nudge.",
      modelResponses: ["Take the medication before lunch."],
      capturedPrompts,
    });
    const service = new ReminderService(runtime);

    const text = await service.renderReminderBody({
      title: "Take medication",
      scheduledFor: "2026-06-23T15:00:00.000Z",
      dueAt: "2026-06-23T15:00:00.000Z",
      channel: "push",
      lifecycle: "initial",
      urgency: "normal",
      subjectType: "owner",
      nearbyReminderTitles: ["Drink water"],
    });

    expect(text).toBe("Take the medication before lunch.");
    expect(capturedPrompts[0]).toContain(
      "OPTIMIZED REMINDER: write a crisp owner nudge.",
    );
    expect(capturedPrompts[0]).not.toContain(
      "Write a short reminder nudge in the assistant's voice.",
    );
    expect(capturedPrompts[0]).toContain("- title: Take medication");
    expect(capturedPrompts[0]).toContain("Other reminders around this time:");
  });
});
