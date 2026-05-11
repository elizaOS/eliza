/**
 * W2-C — CALENDAR / scheduling-negotiation decomposition tests.
 *
 * Wave 2 W2-C extracted the `calendly_*` and `negotiate_*` verbs out of the
 * CALENDAR umbrella per `docs/audit/HARDCODING_AUDIT.md` §6 #13 / §7 and
 * `docs/audit/IMPLEMENTATION_PLAN.md` §5.3.
 *
 * These tests are the structural backstop for that decomposition — they
 * assert that the surfaces stayed narrow (CALENDAR ≤ ~12 verbs, no
 * negotiate_*, no calendly_*) and that the new SCHEDULING_NEGOTIATION
 * action carries all 7 lifecycle verbs in its parameter / planner surface.
 *
 * The handler-level negotiation lifecycle (start → propose → respond →
 * finalize / cancel / list_active / list_proposals against a real DB) is
 * gated by `lifeops-scheduling.real.test.ts`; this file deliberately covers
 * the planner-visible surface to keep the test cheap and stable across the
 * Wave-2 worktrees.
 */

import { describe, expect, it } from "vitest";
import { calendarAction } from "../src/actions/calendar.js";
import { schedulingNegotiationAction } from "../src/actions/scheduling-negotiation.js";

const NEGOTIATION_LIFECYCLE_VERBS = [
  "start",
  "propose",
  "respond",
  "finalize",
  "cancel",
  "list_active",
  "list_proposals",
] as const;

const REMOVED_CALENDAR_SUBACTIONS = [
  "calendly_availability",
  "calendly_list_event_types",
  "calendly_upcoming",
  "calendly_single_use_link",
  "negotiate_start",
  "negotiate_propose",
  "negotiate_respond",
  "negotiate_finalize",
  "negotiate_cancel",
  "negotiate_list_active",
  "negotiate_list_proposals",
];

function findCalendarActionEnum(action: typeof calendarAction): readonly string[] {
  const actionParam = (action.parameters ?? []).find(
    (p) => p.name === "action",
  );
  const schema = actionParam?.schema as { enum?: readonly string[] };
  return schema.enum ?? [];
}

describe("W2-C: CALENDAR umbrella narrowing", () => {
  it("CALENDAR keeps the user-visible name", () => {
    expect(calendarAction.name).toBe("CALENDAR");
  });

  it("CALENDAR exposes ~12 calendar-provider verbs (no calendly_*, no negotiate_*)", () => {
    const verbs = findCalendarActionEnum(calendarAction);
    // ~12 per HARDCODING_AUDIT.md §6 #13. We assert <=14 for a small
    // amount of headroom; the canonical narrowed set today is 11.
    expect(verbs.length).toBeGreaterThanOrEqual(8);
    expect(verbs.length).toBeLessThanOrEqual(14);
  });

  it("CALENDAR drops every calendly_* and negotiate_* subaction", () => {
    const verbs = findCalendarActionEnum(calendarAction);
    for (const removed of REMOVED_CALENDAR_SUBACTIONS) {
      expect(verbs).not.toContain(removed);
    }
  });

  it("CALENDAR keeps bulk_reschedule (compound — preview-then-commit)", () => {
    const verbs = findCalendarActionEnum(calendarAction);
    expect(verbs).toContain("bulk_reschedule");
  });

  it("CALENDAR.subActions does NOT include the calendly or scheduling-negotiation actions", () => {
    const subActionNames = (calendarAction.subActions ?? []).map((s) => s.name);
    expect(subActionNames).not.toContain("CALENDLY");
    expect(subActionNames).not.toContain("SCHEDULING");
    expect(subActionNames).not.toContain("SCHEDULING_NEGOTIATION");
  });

  it("CALENDAR.description does not advertise calendly_ or negotiate_ subactions", () => {
    const description = calendarAction.description ?? "";
    expect(description).not.toMatch(/\bcalendly_(availability|list_event_types|upcoming|single_use_link)\b/);
    expect(description).not.toMatch(/\bnegotiate_(start|propose|respond|finalize|cancel|list_active|list_proposals)\b/);
  });
});

describe("W2-C: SCHEDULING_NEGOTIATION owns the 7-verb lifecycle", () => {
  it("schedulingNegotiationAction exposes a planner-visible action", () => {
    expect(schedulingNegotiationAction.name).toBeTruthy();
    expect(typeof schedulingNegotiationAction.handler).toBe("function");
  });

  it("schedulingNegotiationAction surfaces all 7 lifecycle verbs in its parameter description", () => {
    // The 7 verbs are documented in HARDCODING_AUDIT.md §7. Each must
    // appear in the action's user-facing description so the planner knows
    // it can route every lifecycle step here.
    const subactionParam = (
      schedulingNegotiationAction.parameters ?? []
    ).find((p) => p.name === "subaction");
    const description =
      subactionParam?.description ??
      schedulingNegotiationAction.description ??
      schedulingNegotiationAction.descriptionCompressed ??
      "";
    for (const verb of NEGOTIATION_LIFECYCLE_VERBS) {
      expect(description).toContain(verb);
    }
  });

  it("schedulingNegotiationAction declares the subaction parameter", () => {
    const subactionParam = (
      schedulingNegotiationAction.parameters ?? []
    ).find((p) => p.name === "subaction");
    expect(subactionParam).toBeDefined();
  });

  it("schedulingNegotiationAction suppresses post-action continuation (long-running actor)", () => {
    expect(
      (
        schedulingNegotiationAction as {
          suppressPostActionContinuation?: boolean;
        }
      ).suppressPostActionContinuation,
    ).toBe(true);
  });
});
