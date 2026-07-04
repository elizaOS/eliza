/**
 * Asserts the canonical LifeOps action structure: retired source action names stay
 * unregistered, the owner-operation parent umbrellas register, and each exposes `action` as
 * its public discriminator. Pure plugin-shape asserts, no model.
 */
import { describe, expect, it } from "vitest";
import { isDarwin } from "../src/platform/host.js";
import { personalAssistantPlugin } from "../src/plugin.js";

// OWNER_SCREENTIME is only registered on darwin because the native activity
// tracker is macOS-only. See `platformGatedActionUmbrellas` in src/plugin.ts
// and `b56fb4edf6` (graceful Windows fallbacks for darwin-only features).
const DARWIN_ONLY_PARENTS = new Set(["OWNER_SCREENTIME"]);

const RETIRED_REGISTERED_NAMES = [
  "LIFE",
  "PROFILE",
  "RELATIONSHIP",
  "MONEY",
  "PAYMENTS",
  "SUBSCRIPTIONS",
  "CHECKIN",
  "SCHEDULE",
  "BOOK_TRAVEL",
  "SCHEDULING_NEGOTIATION",
  "FIRST_RUN",
  "TOGGLE_FEATURE",
  "DEVICE_INTENT",
  "MESSAGE_HANDOFF",
  "APP_BLOCK",
  "WEBSITE_BLOCK",
  "AUTOFILL",
  "PASSWORD_MANAGER",
  "GOOGLE_CALENDAR",
  "LIFEOPS",
  "LIFEOPS_THREAD_CONTROL",
  "SCHEDULED_TASK",
  // Scheduling sub-handlers converted to plain functions in Task F teardown;
  // dispatched from CALENDAR umbrella (action=propose_times|check_availability|update_preferences).
  "PROPOSE_MEETING_TIMES",
  "CHECK_AVAILABILITY",
  "UPDATE_MEETING_PREFERENCES",
] as const;

const CANONICAL_OWNER_PARENTS = [
  "OWNER_REMINDERS",
  "OWNER_ALARMS",
  "OWNER_GOALS",
  "OWNER_TODOS",
  "OWNER_ROUTINES",
  "OWNER_HEALTH",
  "OWNER_SCREENTIME",
  "OWNER_FINANCES",
  "PERSONAL_ASSISTANT",
  "BLOCK",
  "CREDENTIALS",
  "CALENDAR",
  "CONNECTOR",
  "RESOLVE_REQUEST",
  "VOICE_CALL",
  "SCHEDULED_TASKS",
  "WORK_THREAD",
] as const;

describe("LifeOps canonical action structure", () => {
  it("does not register retired LifeOps source action names", () => {
    const actionNames = new Set(
      (personalAssistantPlugin.actions ?? []).map((a) => a.name),
    );
    for (const retired of RETIRED_REGISTERED_NAMES) {
      expect(actionNames.has(retired), retired).toBe(false);
    }
  });

  it("registers canonical owner-operation parents", () => {
    const actionNames = new Set(
      (personalAssistantPlugin.actions ?? []).map((a) => a.name),
    );
    const darwin = isDarwin();
    for (const expected of CANONICAL_OWNER_PARENTS) {
      if (!darwin && DARWIN_ONLY_PARENTS.has(expected)) continue;
      expect(actionNames.has(expected), expected).toBe(true);
    }
  });

  it("uses action as the public discriminator on canonical owner-operation parents", () => {
    const actionNames = new Set(CANONICAL_OWNER_PARENTS);
    const failures = (personalAssistantPlugin.actions ?? [])
      .filter((action) =>
        actionNames.has(
          action.name as (typeof CANONICAL_OWNER_PARENTS)[number],
        ),
      )
      .filter((action) => {
        const names = new Set(
          (action.parameters ?? []).map((parameter) => parameter.name),
        );
        return names.has("subaction") && !names.has("action");
      })
      .map((action) => action.name);

    expect(failures).toEqual([]);
  });

  it("routes work-thread Stage-1 behavior through threadOps field evaluator only", () => {
    expect(
      (personalAssistantPlugin.responseHandlerFieldEvaluators ?? []).map(
        (evaluator) => evaluator.name,
      ),
    ).toContain("threadOps");
    expect(
      (personalAssistantPlugin.responseHandlerEvaluators ?? []).map(
        (evaluator) => evaluator.name,
      ),
    ).not.toContain("lifeops.work_thread_router");
  });
});

// Live gemma-4-31b brush-teeth trajectory fences (#9950/#10722): the habit
// save flow only routes correctly when (1) each owner-life umbrella pins its
// backing kind (a planner-supplied kind:"goal" silently rerouted a habit into
// the goals store), (2) the umbrellas expose the `confirmed` preview->confirm
// handshake, and (3) SCHEDULED_TASKS de-claims new-habit creation so a
// habit-shaped ask reaches OWNER_ROUTINES/OWNER_REMINDERS instead of the raw
// scheduler surface. Evidence: .github/issue-evidence/
// 9950-gemma4-31b-live-trajectories/brush-teeth-basic-after-fix*.report.json.
describe("brush-teeth habit-save routing contract (#9950/#10722)", () => {
  const findAction = (name: string) =>
    (personalAssistantPlugin.actions ?? []).find(
      (action) => action.name === name,
    );

  const PINNED_KINDS: Record<string, string> = {
    OWNER_REMINDERS: "definition",
    OWNER_ALARMS: "definition",
    OWNER_TODOS: "definition",
    OWNER_ROUTINES: "definition",
    OWNER_GOALS: "goal",
  };

  it("pins each owner-life umbrella's kind parameter to its backing store", () => {
    for (const [name, kind] of Object.entries(PINNED_KINDS)) {
      const action = findAction(name);
      expect(action, name).toBeDefined();
      const kindParameter = (action?.parameters ?? []).find(
        (parameter) => parameter.name === "kind",
      );
      expect(kindParameter, `${name} kind parameter`).toBeDefined();
      const schema = kindParameter?.schema as {
        enum?: string[];
        default?: string;
      };
      expect(schema?.enum, `${name} kind enum`).toEqual([kind]);
      expect(schema?.default, `${name} kind default`).toBe(kind);
    }
  });

  it("exposes the create-only confirmed handshake on every owner-life umbrella", () => {
    for (const name of Object.keys(PINNED_KINDS)) {
      const action = findAction(name);
      const confirmedParameter = (action?.parameters ?? []).find(
        (parameter) => parameter.name === "confirmed",
      );
      expect(confirmedParameter, `${name} confirmed parameter`).toBeDefined();
      expect(
        (confirmedParameter?.schema as { type?: string })?.type,
        `${name} confirmed type`,
      ).toBe("boolean");
    }
  });

  it("claims habit phrasing on OWNER_ROUTINES and de-claims it on SCHEDULED_TASKS(+_CREATE)", () => {
    const routines = findAction("OWNER_ROUTINES");
    expect(routines?.description).toContain("habit");
    expect(routines?.similes).toContain("CREATE_HABIT");
    expect(routines?.similes).toContain("RECURRING_TASK");

    const scheduledTasks = findAction("SCHEDULED_TASKS");
    expect(scheduledTasks?.description).toContain("OWNER_ROUTINES");
    expect(scheduledTasks?.routingHint).toContain("OWNER_ROUTINES");

    const scheduledTasksCreate = findAction("SCHEDULED_TASKS_CREATE");
    expect(
      scheduledTasksCreate,
      "SCHEDULED_TASKS_CREATE virtual",
    ).toBeDefined();
    expect(scheduledTasksCreate?.description).toContain(
      "OWNER_ROUTINES_CREATE",
    );
  });

  it("declares the productivity context on owner-life umbrellas (Stage-1 boost parity with SCHEDULED_TASKS)", () => {
    for (const name of Object.keys(PINNED_KINDS)) {
      const action = findAction(name);
      expect(action?.contexts, `${name} contexts`).toContain("productivity");
    }
  });
});
