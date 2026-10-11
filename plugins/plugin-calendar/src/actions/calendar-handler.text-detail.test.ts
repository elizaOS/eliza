/**
 * Lookup keys keep non-Latin letters: a Korean or Japanese place is a detail
 * distinct from the title, a non-Latin title slugged into eventId is still the
 * title, and Intl month/weekday names resolve. Pure helpers, no runtime.
 */
import type { LifeOpsCalendarEvent } from "@elizaos/contracts";
import { describe, expect, it } from "vitest";
import {
  normalizeCalendarDetails,
  parseExplicitLocalDate,
  textFieldAddsDetail,
  verifyAppliedCalendarMutation,
} from "./calendar-handler";

// Thursday 2026-10-15 12:00 in Seoul; "Friday" is tomorrow.
const NOW = new Date("2026-10-15T03:00:00.000Z");
const ZONE = "Asia/Seoul";

function seoulEvent(title: string, location: string): LifeOpsCalendarEvent {
  return {
    id: "evt-1",
    externalId: "evt-1",
    agentId: "agent-1",
    provider: "eliza",
    side: "owner",
    calendarId: "primary",
    title,
    description: "",
    location,
    status: "confirmed",
    startAt: "2026-10-16T06:00:00.000Z",
    endAt: "2026-10-16T07:00:00.000Z",
    isAllDay: false,
    timezone: ZONE,
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: {},
    syncedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function createReceipt(requestText: string, event: LifeOpsCalendarEvent) {
  return verifyAppliedCalendarMutation({
    operation: "create",
    requestText,
    event,
    fallbackTimeZone: ZONE,
    now: NOW,
    carriesUnshownDetails:
      textFieldAddsDetail(event.location, event.title) ||
      textFieldAddsDetail(event.description, event.title),
  });
}

describe("textFieldAddsDetail", () => {
  it("counts a non-Latin place that differs from the title", () => {
    expect(textFieldAddsDetail("강남역", "치과 예약")).toBe(true);
    expect(textFieldAddsDetail("新宿", "歯医者")).toBe(true);
    expect(textFieldAddsDetail("Main St", "Dentist")).toBe(true);
  });

  it("still treats a repeat of the title as no detail", () => {
    expect(
      textFieldAddsDetail("Optometrist appointment", "Optometrist appointment"),
    ).toBe(false);
    expect(textFieldAddsDetail("치과예약!", "치과 예약")).toBe(false);
    expect(textFieldAddsDetail("  ", "치과 예약")).toBe(false);
  });
});

describe("verifyAppliedCalendarMutation create with a place", () => {
  it("withholds the bare receipt when a Korean place was set, as for English", () => {
    const request = "금요일 15:00 강남역에서 치과 예약해줘";
    expect(createReceipt(request, seoulEvent("치과 예약", ""))).toMatch(
      /^Created “치과 예약” for tomorrow, Friday, .* at 3pm/,
    );
    expect(
      createReceipt(request, seoulEvent("치과 예약", "강남역")),
    ).toBeNull();
    expect(
      createReceipt("金曜日 15:00 新宿で歯医者", seoulEvent("歯医者", "新宿")),
    ).toBeNull();

    const english = "dentist friday 15:00 at Main St";
    expect(createReceipt(english, seoulEvent("Dentist", ""))).toMatch(
      /^Created “Dentist” for tomorrow, Friday, .* at 3pm/,
    );
    expect(createReceipt(english, seoulEvent("Dentist", "Main St"))).toBeNull();
    expect(
      createReceipt(
        "optometrist appointment friday 15:00",
        seoulEvent("Optometrist appointment", "Optometrist appointment"),
      ),
    ).toMatch(
      /^Created “Optometrist appointment” for tomorrow, Friday, .* at 3pm/,
    );
  });
});

describe("normalizeCalendarDetails eventId screen", () => {
  it("drops a non-Latin title slugged into eventId", () => {
    expect(
      normalizeCalendarDetails({ title: "치과 예약", eventId: "치과_예약" }),
    ).toEqual({ title: "치과 예약" });
    expect(
      normalizeCalendarDetails({
        title: "claim probe two",
        eventId: "claim_probe_two",
      }),
    ).toEqual({ title: "claim probe two" });
    expect(
      normalizeCalendarDetails({ title: "치과 예약", eventId: "abc123xyz" }),
    ).toEqual({ title: "치과 예약", eventId: "abc123xyz" });
  });
});

describe("parseExplicitLocalDate Intl names", () => {
  it("resolves Korean month and Spanish weekday names", () => {
    expect(parseExplicitLocalDate("3월 15일 오후 3시", ZONE, NOW)).toEqual({
      year: 2026,
      month: 3,
      day: 15,
    });
    expect(parseExplicitLocalDate("el sábado a las 15:00", ZONE, NOW)).toEqual({
      year: 2026,
      month: 10,
      day: 17,
    });
    expect(parseExplicitLocalDate("march 15", ZONE, NOW)).toEqual({
      year: 2026,
      month: 3,
      day: 15,
    });
    expect(parseExplicitLocalDate("next friday", ZONE, NOW)).toEqual({
      year: 2026,
      month: 10,
      day: 23,
    });
  });
});
