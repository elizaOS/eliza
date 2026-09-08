/**
 * Target selection for calendar update/delete when the planner's `details.date`
 * contradicts the only event carrying the requested title. Pure function under
 * test; no runtime, model, or calendar service.
 */
import type { LifeOpsCalendarEvent } from "@elizaos/shared/contracts/calendar";
import { describe, expect, it } from "vitest";
import { resolveCalendarMutationCandidates } from "./calendar-handler.js";

const TZ = "America/Los_Angeles";
function event(
  id: string,
  title: string,
  startAt: string,
): LifeOpsCalendarEvent {
  return {
    id,
    title,
    startAt,
    endAt: startAt,
    isAllDay: false,
    timezone: TZ,
  } as unknown as LifeOpsCalendarEvent;
}
const dentistFriday = event(
  "e1",
  "Dentist appointment",
  "2026-09-11T22:00:00.000Z",
);
const dentistSaturday = event(
  "e2",
  "Dentist appointment",
  "2026-09-12T22:00:00.000Z",
);
const gym = event("e3", "Gym session", "2026-09-11T14:00:00.000Z");

describe("resolveCalendarMutationCandidates with a planner-authored date", () => {
  it("keeps the only title match when details.date alone contradicts it", () => {
    // Live 2026-09-06 21:15: "move my dentist appointment to friday at 4pm"
    // arrived with details.date 2026-09-04 while the appointment was on the 11th.
    const candidates = resolveCalendarMutationCandidates({
      action: "update",
      events: [dentistFriday, gym],
      titleHint: "dentist appointment",
      texts: [
        "move my dentist appointment to friday at 4pm",
        undefined,
        "2026-09-04",
      ],
      explicitDate: "2026-09-04",
      nonPlannerDateTexts: ["move my dentist appointment to friday at 4pm"],
      timeZone: TZ,
    });
    expect(candidates.map((c) => c.id)).toEqual(["e1"]);
  });

  it("still honours a day the user stated in their own words", () => {
    const candidates = resolveCalendarMutationCandidates({
      action: "update",
      events: [dentistFriday, gym],
      titleHint: "dentist appointment",
      texts: [
        "move my september 4 dentist appointment to 4pm",
        undefined,
        "2026-09-04",
      ],
      explicitDate: "2026-09-04",
      timeZone: TZ,
    });
    expect(candidates).toEqual([]);
  });

  it("does not turn an unmatched date into permission to mutate the only unrelated event", () => {
    expect(
      resolveCalendarMutationCandidates({
        action: "delete",
        events: [gym],
        titleHint: undefined,
        texts: ["delete the event", "2026-09-04"],
        explicitDate: "2026-09-04",
        nonPlannerDateTexts: ["delete the event"],
        timeZone: TZ,
      }),
    ).toEqual([]);
  });

  it("preserves an authoritative date even when its bytes equal the planner field", () => {
    expect(
      resolveCalendarMutationCandidates({
        action: "delete",
        events: [dentistFriday],
        titleHint: "dentist appointment",
        texts: ["2026-09-04", "2026-09-04"],
        explicitDate: "2026-09-04",
        nonPlannerDateTexts: ["2026-09-04"],
        timeZone: TZ,
      }),
    ).toEqual([]);
  });

  it("does not pick among several title matches on a wrong date", () => {
    const candidates = resolveCalendarMutationCandidates({
      action: "update",
      events: [dentistFriday, dentistSaturday],
      titleHint: "dentist appointment",
      texts: ["move my dentist appointment to 4pm", undefined, "2026-09-04"],
      explicitDate: "2026-09-04",
      timeZone: TZ,
    });
    expect(candidates).toEqual([]);
  });

  it("uses a correct details.date to choose among several title matches", () => {
    const candidates = resolveCalendarMutationCandidates({
      action: "update",
      events: [dentistFriday, dentistSaturday],
      titleHint: "dentist appointment",
      texts: ["move my dentist appointment to 4pm", undefined, "2026-09-12"],
      explicitDate: "2026-09-12",
      timeZone: TZ,
    });
    expect(candidates.map((c) => c.id)).toEqual(["e2"]);
  });
});
