/**
 * Unit coverage for the LifeOps GEPA seed script's pure helpers — argument
 * bounds parsing, the seed-task table, and the persist gate that only promotes an
 * optimized prompt when it beats the baseline. No model calls.
 */
import { describe, expect, it } from "vitest";
import {
  parseBoundedIntegerArg,
  SEED_TASKS,
  validatePersistableResult,
} from "../../scripts/lifeops-gepa-seed.ts";
import type { OptimizerResult } from "../optimizers/index.js";

function makeResult(
  seedPrompt: string,
  score: number,
  baseline: number,
): OptimizerResult {
  return {
    optimizedPrompt: seedPrompt,
    score,
    baseline,
    lineage: [],
  };
}

describe("lifeops-gepa-seed", () => {
  it("exposes all eight LifeOps per-capability seed tasks", () => {
    expect(Object.keys(SEED_TASKS).sort()).toEqual([
      "calendar_extract",
      "health_checkin",
      "inbox_triage",
      "meeting_prep",
      "morning_brief",
      "reminder_dispatch",
      "schedule_plan",
      "screentime_recap",
    ]);
  });

  it("uses the live health planner baseline and JSON-shaped examples", () => {
    const seed = SEED_TASKS.health_checkin;
    expect(seed.baseline).toContain("Plan the HEALTH action");
    expect(seed.baseline).toContain("subaction");
    expect(seed.baseline).toContain("by_metric");

    expect(seed.dataset.length).toBeGreaterThanOrEqual(8);

    const subactions = seed.dataset.map(
      (example) =>
        (JSON.parse(example.expectedOutput) as { subaction: string | null })
          .subaction,
    );
    // Every actionable subaction plus the vague-guard null appears at least once.
    for (const subaction of ["today", "trend", "by_metric", "status", null]) {
      expect(subactions).toContain(subaction);
    }

    for (const example of seed.dataset) {
      expect(example.input.user).toContain("Current request:");
      const parsed = JSON.parse(example.expectedOutput) as Record<
        string,
        unknown
      >;
      expect(parsed).toHaveProperty("subaction");
      expect(parsed).toHaveProperty("shouldAct");
    }
  });

  it("uses the live calendar planner baseline and schema-shaped examples", () => {
    const seed = SEED_TASKS.calendar_extract;
    expect(seed.baseline).toContain("Plan the calendar action");
    expect(seed.baseline).toContain("subaction");
    expect(seed.baseline).toContain("timeMin");

    for (const example of seed.dataset) {
      expect(example.input.user).toContain("LOCAL DATE ANCHORS");
      expect(example.input.user).toContain("Current request:");

      const parsed = JSON.parse(example.expectedOutput) as Record<
        string,
        unknown
      >;
      expect(parsed).toHaveProperty("subaction");
      expect(parsed).toHaveProperty("shouldAct");
      expect(parsed).not.toHaveProperty("date");
      expect(parsed).not.toHaveProperty("startTime");
      expect(parsed).not.toHaveProperty("endTime");
    }
  });

  it("uses the live scheduling planner baseline and JSON-shaped examples", () => {
    const seed = SEED_TASKS.schedule_plan;
    expect(seed.baseline).toContain("Plan the scheduling negotiation action");
    expect(seed.baseline).toContain("subaction");
    expect(seed.baseline).toContain("finalize");

    expect(seed.dataset.length).toBeGreaterThanOrEqual(8);

    const subactions = seed.dataset.map(
      (example) =>
        (JSON.parse(example.expectedOutput) as { subaction: string | null })
          .subaction,
    );
    // Every actionable subaction appears at least once.
    for (const subaction of [
      "start",
      "propose",
      "respond",
      "finalize",
      "cancel",
      "list_active",
      "list_proposals",
    ]) {
      expect(subactions).toContain(subaction);
    }
    // The wrong-tool / vague guard (shouldAct=false) is represented.
    expect(
      seed.dataset.some((example) => {
        const parsed = JSON.parse(example.expectedOutput) as {
          subaction: string | null;
          shouldAct: boolean;
        };
        return parsed.subaction === null && parsed.shouldAct === false;
      }),
    ).toBe(true);
    // Multilingual coverage per the GEPA real-conversation requirement.
    expect(
      seed.dataset.some((example) =>
        /créneau|Acepto|propuesta/.test(example.input.user),
      ),
    ).toBe(true);

    for (const example of seed.dataset) {
      expect(example.input.user).toContain("Current request:");
      const parsed = JSON.parse(example.expectedOutput) as Record<
        string,
        unknown
      >;
      expect(parsed).toHaveProperty("subaction");
      expect(parsed).toHaveProperty("shouldAct");
    }
  });

  it("blocks malformed scheduling prompts from persistence", () => {
    const seed = SEED_TASKS.schedule_plan;
    const malformed = validatePersistableResult(
      seed,
      makeResult("Return JSON with subaction and shouldAct.", 0.9, 0.1),
    );
    expect(malformed).toEqual(
      expect.arrayContaining([expect.stringContaining('"finalize"')]),
    );

    expect(
      validatePersistableResult(seed, makeResult(seed.baseline, 0.9, 0.1)),
    ).toEqual([]);
  });

  it("uses the live inbox classifier baseline and category-shaped examples", () => {
    const seed = SEED_TASKS.inbox_triage;
    expect(seed.baseline).toContain(
      "Classify each message into one of these categories",
    );
    expect(seed.baseline).toContain("needs_reply");
    expect(seed.baseline).toContain("suggestedResponse");

    expect(seed.dataset.length).toBeGreaterThanOrEqual(6);
    expect(
      seed.dataset.some((example) =>
        example.expectedOutput.includes('"category":"needs_reply"'),
      ),
    ).toBe(true);
    expect(
      seed.dataset.some((example) =>
        example.expectedOutput.includes('"category":"urgent"'),
      ),
    ).toBe(true);
    expect(
      seed.dataset.some((example) =>
        example.expectedOutput.includes('"category":"ignore"'),
      ),
    ).toBe(true);

    for (const example of seed.dataset) {
      expect(example.input.user).toContain("Messages:");
      expect(example.expectedOutput).toMatch(/"category":"[^"]+"/);
      expect(example.expectedOutput).toMatch(/"urgency":"(low|medium|high)"/);
    }
  });

  it("validates numeric CLI bounds", () => {
    expect(
      parseBoundedIntegerArg("generations", undefined, {
        defaultValue: 2,
        min: 1,
        max: 20,
      }),
    ).toBe(2);
    expect(
      parseBoundedIntegerArg("generations", "3", {
        defaultValue: 2,
        min: 1,
        max: 20,
      }),
    ).toBe(3);
    expect(() =>
      parseBoundedIntegerArg("generations", "0", {
        defaultValue: 2,
        min: 1,
        max: 20,
      }),
    ).toThrow(/--generations/);
    expect(() =>
      parseBoundedIntegerArg("population", "2.5", {
        defaultValue: 4,
        min: 2,
        max: 50,
      }),
    ).toThrow(/--population/);
  });

  it("blocks non-improving or malformed calendar prompts from persistence", () => {
    const seed = SEED_TASKS.calendar_extract;
    const nonImproving = validatePersistableResult(
      seed,
      makeResult(seed.baseline, 0.5, 0.5),
    );
    expect(nonImproving).toEqual(
      expect.arrayContaining([
        expect.stringContaining("optimized score must beat baseline"),
      ]),
    );

    const malformed = validatePersistableResult(
      seed,
      makeResult("Return JSON with subaction and shouldAct.", 0.9, 0.1),
    );
    expect(malformed).toEqual(
      expect.arrayContaining([expect.stringContaining('"queries"')]),
    );

    expect(
      validatePersistableResult(seed, makeResult(seed.baseline, 0.9, 0.1)),
    ).toEqual([]);
  });

  it("blocks malformed inbox prompts from persistence", () => {
    const seed = SEED_TASKS.inbox_triage;
    const malformed = validatePersistableResult(
      seed,
      makeResult("Return fields for category and urgency.", 0.9, 0.1),
    );
    expect(malformed).toEqual(
      expect.arrayContaining([expect.stringContaining('"needs_reply"')]),
    );

    expect(
      validatePersistableResult(seed, makeResult(seed.baseline, 0.9, 0.1)),
    ).toEqual([]);
  });

  // --- prose/NL judge-graded tasks (#11384) ---

  const JUDGE_TASK_NAMES = [
    "reminder_dispatch",
    "meeting_prep",
    "morning_brief",
    "screentime_recap",
  ] as const;

  it("every NL task row carries a judge rubric expectation", () => {
    for (const name of JUDGE_TASK_NAMES) {
      const seed = SEED_TASKS[name];
      expect(seed, name).toBeDefined();
      expect(seed.dataset.length, name).toBeGreaterThanOrEqual(8);
      for (const example of seed.dataset) {
        const parsed = JSON.parse(example.expectedOutput) as {
          reference: unknown;
          rubric: unknown;
        };
        expect(typeof parsed.reference, name).toBe("string");
        expect(Array.isArray(parsed.rubric), name).toBe(true);
        expect((parsed.rubric as string[]).length, name).toBeGreaterThanOrEqual(
          3,
        );
      }
    }
  });

  it("reminder_dispatch mirrors the live dispatch prompt and covers lifecycle/urgency/language axes", () => {
    const seed = SEED_TASKS.reminder_dispatch;
    expect(seed.baseline).toContain("Write a short reminder nudge");
    for (const example of seed.dataset) {
      expect(example.input.user).toContain("Current reminder:");
      expect(example.input.user).toContain("Reminder text:");
    }
    const inputs = seed.dataset.map((example) => example.input.user).join("\n");
    expect(inputs).toContain("lifecycle: escalation");
    expect(inputs).toContain("urgency: critical");
    // Multilingual coverage per the GEPA real-conversation requirement.
    expect(inputs).toContain("la basura");
    expect(inputs).toContain("appeler maman");
  });

  it("morning_brief mirrors the live narrative prompt with structured section payloads", () => {
    const seed = SEED_TASKS.morning_brief;
    expect(seed.baseline).toContain("narrative paragraph");
    for (const example of seed.dataset) {
      expect(example.input.user).toContain("You are composing the owner's");
      expect(example.input.user).toContain("Data:");
      const payload = JSON.parse(
        example.input.user.slice(example.input.user.indexOf("{")),
      ) as { sections: Record<string, unknown> };
      expect(payload.sections).toBeDefined();
    }
    // Empty-day and money-domain rows are represented.
    expect(
      seed.dataset.some((example) => example.input.user.includes('"money"')),
    ).toBe(true);
    expect(
      seed.dataset.some((example) =>
        example.input.user.includes('"calendar": []'),
      ),
    ).toBe(true);
  });

  it("meeting_prep rows exercise gap-surfacing (missing agenda, blockers, decision owners)", () => {
    const seed = SEED_TASKS.meeting_prep;
    expect(seed.baseline).toContain("agenda");
    const rubrics = seed.dataset
      .flatMap(
        (example) =>
          (JSON.parse(example.expectedOutput) as { rubric: string[] }).rubric,
      )
      .join("\n");
    expect(rubrics).toContain("agenda");
    expect(rubrics).toContain("blocker");
    expect(rubrics).toContain("decision");
  });

  it("screentime_recap rows pin the JSON envelope and change-vs-prior emphasis", () => {
    const seed = SEED_TASKS.screentime_recap;
    expect(seed.baseline).toContain("topApps");
    for (const example of seed.dataset) {
      expect(example.input.user).toContain("Screen-time context:");
      const rubric = (
        JSON.parse(example.expectedOutput) as { rubric: string[] }
      ).rubric.join("\n");
      expect(rubric).toContain("recap");
      expect(rubric).toContain("topApps");
      expect(rubric).toContain("suggestion");
    }
    // The no-prior-baseline guard row is represented.
    expect(
      seed.dataset.some((example) =>
        example.input.user.includes("no data recorded"),
      ),
    ).toBe(true);
  });

  it("blocks degenerate NL prompts from persistence via required fragments", () => {
    const reminder = SEED_TASKS.reminder_dispatch;
    expect(
      validatePersistableResult(
        reminder,
        makeResult("Write something short.", 0.9, 0.1),
      ),
    ).toEqual(expect.arrayContaining([expect.stringContaining('"reminder"')]));
    expect(
      validatePersistableResult(
        reminder,
        makeResult(reminder.baseline, 0.9, 0.1),
      ),
    ).toEqual([]);

    const recap = SEED_TASKS.screentime_recap;
    expect(
      validatePersistableResult(
        recap,
        makeResult("Summarize usage as JSON.", 0.9, 0.1),
      ),
    ).toEqual(expect.arrayContaining([expect.stringContaining('"topApps"')]));
    expect(
      validatePersistableResult(recap, makeResult(recap.baseline, 0.9, 0.1)),
    ).toEqual([]);

    const brief = SEED_TASKS.morning_brief;
    expect(
      validatePersistableResult(brief, makeResult(brief.baseline, 0.9, 0.1)),
    ).toEqual([]);
    const prep = SEED_TASKS.meeting_prep;
    expect(
      validatePersistableResult(prep, makeResult(prep.baseline, 0.9, 0.1)),
    ).toEqual([]);
  });
});
