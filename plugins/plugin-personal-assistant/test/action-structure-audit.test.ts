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
  // Scheduling sub-handlers converted to plain functions in Task F cleanup;
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
