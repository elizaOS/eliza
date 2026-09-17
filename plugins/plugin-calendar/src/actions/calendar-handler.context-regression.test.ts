/** Exercises calendar mutation inputs against complete explicit user field requests. */
import { describe, expect, it } from "vitest";
import {
  buildCreateEventRequest,
  calendarUpdateTextField,
  createCalendarActionRunner,
  formatCreateEventRecentConversation,
  resolveUpdateTimeRange,
} from "./calendar-handler";

describe("explicit calendar field preservation", () => {
  it("does not revive planner timing when authoritative extraction found none", () => {
    const built = buildCreateEventRequest({
      details: {
        start: "2026-09-17T15:30:00",
        end: "2026-09-17T15:45:00",
        windowPreset: "tomorrow_afternoon",
      },
      extractedDetails: { title: "Call dad" },
      explicitTitle: "Call dad",
      inferredTitle: undefined,
      preferExtractedDetails: true,
      requireExtractedTiming: true,
      authorizingUserTexts: ["make a calendar reminder to call my dad"],
    });
    expect(built.resolvedStartAt).toBeUndefined();
    expect(built.resolvedWindowPreset).toBeUndefined();
    expect(built.request.startAt).toBeUndefined();
    expect(built.request.endAt).toBeUndefined();
  });

  it("uses recovered conversation timing without retaining a fabricated planner end", () => {
    const built = buildCreateEventRequest({
      details: { start: "2026-09-17T15:30:00", end: "2026-09-17T15:45:00" },
      extractedDetails: {
        startAt: "2026-09-18T16:00:00-04:00",
        durationMinutes: 30,
      },
      explicitTitle: "Call dad",
      inferredTitle: undefined,
      preferExtractedDetails: true,
      requireExtractedTiming: true,
      authorizingUserTexts: ["yes, add it"],
    });
    expect(built.request.startAt).toBe("2026-09-18T16:00:00-04:00");
    expect(built.request.endAt).toBeUndefined();
    expect(built.request.durationMinutes).toBe(30);
  });

  it.each([
    ["description", "Friday", "Set the description to Friday."],
    ["description", "N/A", "Set the description to N/A."],
    ["location", "Default", "Set the location to Default."],
    [
      "location",
      "Barber",
      "Set the location to Barber for my Barber appointment.",
    ],
  ] as const)("preserves explicitly requested %s value %s", (field, value) => {
    expect(calendarUpdateTextField({ [field]: value }, {}, field)).toBe(value);
  });

  it("keeps an invalid explicit time range for the service's typed validation", () => {
    expect(
      resolveUpdateTimeRange({
        explicitStart: "2026-09-18T16:00:00Z",
        explicitEnd: "2026-09-18T15:00:00Z",
        target: {
          startAt: "2026-09-18T12:00:00Z",
          endAt: "2026-09-18T13:00:00Z",
        },
        timeZone: "UTC",
      }),
    ).toMatchObject({
      startAt: "2026-09-18T16:00:00Z",
      endAt: "2026-09-18T15:00:00Z",
    });
  });
});

describe("explicit travel preparation", () => {
  it("retains requested travel when the missing destination needs clarification", () => {
    createCalendarActionRunner({
      async runTextModel() {
        throw new Error("Unexpected model call");
      },
      async runJsonModel() {
        throw new Error("Unexpected model call");
      },
      async recentConversationTexts() {
        return [];
      },
      travelBuffer: {
        resolveTravelIntent({ details }) {
          return typeof details?.travelOriginAddress === "string"
            ? { originAddress: details.travelOriginAddress }
            : null;
        },
        async computeTravelBuffer() {
          throw new Error("Not dispatched by request construction");
        },
        async reserveTravelBuffer() {
          throw new Error("Not dispatched by request construction");
        },
        isTravelTimeUnavailable(
          _error,
        ): _error is { code: string; message: string } {
          return false;
        },
      },
    });
    const built = buildCreateEventRequest({
      details: {
        title: "dentist",
        startAt: "2026-09-18T15:00:00Z",
        travelOriginAddress: "home",
      },
      extractedDetails: {},
      explicitTitle: "dentist",
      inferredTitle: "dentist",
      authorizingUserTexts: [
        "Book the dentist Friday at 3 and add travel time from home.",
      ],
    });
    expect(built.travelIntent).toEqual({ originAddress: "home" });
    expect(built.request.location).toBeUndefined();
  });
});

it("preserves complete calendar follow-up history including unprefixed continuation lines", () => {
  const original =
    "[2026-09-17T18:40:00Z] user: 4:45 PM tomorrow\nfor 15 minutes\n\n[2026-09-17T18:39:00Z] assistant: What time?";
  expect(
    formatCreateEventRecentConversation({
      values: { recentMessages: original },
      data: {},
      text: "other providers",
    }),
  ).toBe(original);
});
