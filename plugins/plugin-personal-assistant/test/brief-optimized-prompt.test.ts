/**
 * Routing coverage for the `morning_brief` LifeOps optimization task (#8795).
 * The briefing-narrative instructions must consult OptimizedPromptService and
 * use an optimized artifact when one is registered, falling back to the inline
 * baseline otherwise (absence of an artifact is a no-op, never a failure).
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { buildNarrativePrompt } from "../src/actions/brief.js";
import { buildSchedulingPlanPrompt } from "../src/actions/lib/scheduling-handler.js";
import { buildReminderDispatchPrompt } from "../src/lifeops/service-mixin-reminders.js";

const SECTIONS = {
  calendar: [],
  inbox: [],
  life: [],
  money: [],
} as never;

function runtimeWithOptimizedPrompt(
  promptByTask: Record<string, string>,
): IAgentRuntime {
  return {
    getService: (name: string) =>
      name === "optimized_prompt"
        ? {
            getPrompt: (task: string) =>
              promptByTask[task]
                ? { prompt: promptByTask[task], optimizerSource: "gepa" }
                : null,
          }
        : null,
  } as unknown as IAgentRuntime;
}

describe("BRIEF narrative — OptimizedPromptService routing", () => {
  it("uses the inline baseline when no artifact is registered", () => {
    const prompt = buildNarrativePrompt({
      kind: "morning",
      period: "today",
      sections: SECTIONS,
    });
    expect(prompt).toContain("Render a concise narrative paragraph");
    expect(prompt).toContain("composing the owner's morning briefing");
  });

  it("uses the inline baseline when a runtime has no optimized prompt", () => {
    const runtime = runtimeWithOptimizedPrompt({});
    const prompt = buildNarrativePrompt({
      kind: "morning",
      period: "today",
      sections: SECTIONS,
      runtime,
    });
    expect(prompt).toContain("Render a concise narrative paragraph");
  });

  it("swaps in the optimized morning_brief artifact when present", () => {
    const runtime = runtimeWithOptimizedPrompt({
      morning_brief: "OPTIMIZED: be terse and lead with the day's single risk.",
    });
    const prompt = buildNarrativePrompt({
      kind: "morning",
      period: "today",
      sections: SECTIONS,
      sourceErrors: { calendar: "unavailable" },
      runtime,
    });
    expect(prompt).toContain(
      "OPTIMIZED: be terse and lead with the day's single risk.",
    );
    // The inline baseline instructions are replaced by the artifact.
    expect(prompt).not.toContain("Render a concise narrative paragraph");
    // The dynamic header + data scaffold is preserved around the instructions.
    expect(prompt).toContain("composing the owner's morning briefing");
    expect(prompt).toContain("Data:");
    expect(JSON.parse(prompt.split("Data:\n")[1]).sourceErrors).toEqual({
      calendar: "unavailable",
    });
    expect(prompt).toContain("are unavailable, not empty");
  });

  it.each([false, true])(
    "keeps human briefing rules and complete canonical facts with optimized=%s",
    (optimized) => {
      const sections = {
        calendar: [],
        inbox: [],
        life: [
          {
            id: "open-reminder",
            kind: "reminder" as const,
            title: "Stretch",
            state: "visible" as const,
            dueAt: "2026-02-05T16:30:00.000Z",
          },
        ],
        completedToday: [
          {
            id: "completed-reminder",
            kind: "reminder" as const,
            title: "Read the chapter",
            state: "completed" as const,
            dueAt: "2026-02-04T16:00:00.000Z",
          },
        ],
      };
      const original = structuredClone(sections);
      const prompt = buildNarrativePrompt({
        kind: "evening",
        period: "today",
        sections,
        asOf: "2026-02-05T16:35:00.000Z",
        timeZone: "Asia/Tokyo",
        sourceErrors: { inbox: "unavailable" },
        lifeSummary: {
          activeOccurrenceCount: 1,
          overdueOccurrenceCount: 1,
          snoozedOccurrenceCount: 0,
          activeReminderCount: 1,
          activeGoalCount: 0,
        },
        ...(optimized
          ? {
              runtime: runtimeWithOptimizedPrompt({
                morning_brief: "OPTIMIZED: rank the current risk first.",
              }),
            }
          : {}),
      });
      // These semantic guardrails survive optimized artifact replacement; no
      // second compose call or mutation of the stored briefing is involved.
      expect(prompt).toContain(
        "start with what was marked done today; the editorial lead then guides",
      );
      expect(prompt).toContain(
        "An uncompleted reminder record does not prove that its real-world activity is unfinished",
      );
      expect(prompt).toContain(
        "scheduled time, not activation or delivery time",
      );
      expect(prompt).toContain("ordinary-language clause");
      expect(prompt).toContain("not empty");
      const payload = JSON.parse(prompt.split("Data:\n")[1]);
      expect(payload.sections.life[0]).toMatchObject(sections.life[0]);
      expect(payload.sections.completedToday[0]).toMatchObject(
        sections.completedToday[0],
      );
      expect(payload.sourceErrors).toEqual({ inbox: "unavailable" });
      expect(payload.lifeSummary.activeOccurrenceCount).toBe(1);
      expect(payload.timeZone).toBe("Asia/Tokyo");
      expect(
        payload.sections.completedToday[0].timeContext.dueAt.localDate,
      ).toBe("2026-02-05");
      expect(sections).toEqual(original);
    },
  );

  it("swaps in the optimized meeting_prep artifact for meeting prep briefs", () => {
    const runtime = runtimeWithOptimizedPrompt({
      meeting_prep: "OPTIMIZED: surface agenda gaps and decision owners first.",
    });
    const prompt = buildNarrativePrompt({
      kind: "morning",
      period: "tomorrow",
      sections: {
        calendar: [
          {
            id: "evt-board",
            title: "Board meeting",
            startAt: "2026-06-25T16:00:00.000Z",
            endAt: "2026-06-25T17:00:00.000Z",
          },
        ],
        inbox: [],
        life: [],
        money: [],
      },
      runtime,
      optimizationTask: "meeting_prep",
    });

    expect(prompt).toContain(
      "OPTIMIZED: surface agenda gaps and decision owners first.",
    );
    expect(prompt).not.toContain("Prepare the next working block");
    expect(prompt).toContain("composing the owner's morning briefing");
    expect(prompt).toContain("Board meeting");
  });
});

describe("LifeOps action prompts — OptimizedPromptService routing", () => {
  it("swaps in the optimized schedule_plan instructions and preserves request data", () => {
    const runtime = runtimeWithOptimizedPrompt({
      schedule_plan: "OPTIMIZED: choose the safest scheduling subaction.",
    });
    const prompt = buildSchedulingPlanPrompt({
      runtime,
      currentMessage: "Start a scheduling thread with Sam for next week.",
      intent: "schedule with Sam",
      params: { intent: "schedule with Sam", durationMinutes: 30 },
      recentConversation: "User: next week is better",
    });

    expect(prompt).toContain(
      "OPTIMIZED: choose the safest scheduling subaction.",
    );
    expect(prompt).not.toContain("Plan the scheduling negotiation action");
    expect(prompt).toContain(
      "Current request:\nStart a scheduling thread with Sam for next week.",
    );
    expect(prompt).toContain("durationMinutes: 30");
  });

  it("swaps in the optimized reminder_dispatch instructions and preserves reminder data", () => {
    const runtime = {
      ...runtimeWithOptimizedPrompt({
        reminder_dispatch: "OPTIMIZED: dispatch concise reminder copy.",
      }),
      character: { name: "Eliza", bio: "Direct but warm." },
    } as unknown as IAgentRuntime;

    const prompt = buildReminderDispatchPrompt({
      runtime,
      title: "Take medication",
      reminderAt: "2026-06-23T14:00:00.000Z",
      channel: "push",
      lifecycle: "plan",
      urgency: "high",
      recentConversation: ["User: I'm between meetings."],
      nearbyReminderTitles: ["Call pharmacy"],
    });

    expect(prompt).toContain("OPTIMIZED: dispatch concise reminder copy.");
    expect(prompt).not.toContain("Write a short reminder nudge");
    expect(prompt).toContain("- title: Take medication");
    expect(prompt).toContain("- channel: push");
    expect(prompt).toContain("User: I'm between meetings.");
    expect(prompt).toContain("- Call pharmacy");
  });
});
