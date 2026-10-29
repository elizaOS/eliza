/**
 * Lookup keys keep non-Latin letters: a Korean or Japanese place is a detail
 * distinct from the title, a non-Latin title slugged into eventId is still the
 * title, and Intl month/weekday names resolve. Pure helpers, no runtime.
 */
import type { LifeOpsCalendarEvent } from "@elizaos/contracts";
import { InferenceTurnTimer, runWithInferenceTiming } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  dedupeCalendarQueries,
  isRedundantObservedClockQuery,
  normalizeCalendarDetails,
  observedCalendarDayWindow,
  parseExplicitLocalDate,
  textFieldAddsDetail,
  verifyAppliedCalendarMutation,
} from "./calendar-handler";
import { timeCalendarUpdate } from "./update-timing.js";

// Thursday 2026-10-15 12:00 in Seoul; "Friday" is tomorrow.
const NOW = new Date("2026-10-15T03:00:00.000Z");
const ZONE = "Asia/Seoul";

describe("current Calendar day observation", () => {
  const original = {
    text: "Move my 3pm to 4",
    observedAt: new Date("2026-10-28T12:00:00Z"),
  };
  const context = {
    view: "calendar",
    revision: 3,
    sensitive: false,
    timeZone: "UTC",
    calendarDay: { date: "2026-10-29", timeZone: "UTC" },
  };
  it("recognizes only a redundant original source clock, without interpreting the destination", () => {
    const window = observedCalendarDayWindow(context, original, "UTC");
    const base = {
      original: original.text,
      queries: ["3pm"],
      window,
      detailsDate: "2026-10-29",
      explicitTarget: false,
    };
    expect(isRedundantObservedClockQuery(base)).toBe(true);
    for (const patch of [
      { queries: ["Dentist"] },
      { queries: ["3pm", "Dentist"] },
      { queries: ["3pm Dentist"] },
      { original: "Move my '3pm' to 4" },
      { original: 'Move my "3pm" to 4' },
      { original: "Move my 3pm to 4 if I am free" },
      { original: "Move my 3pm to 4 and invite Sam" },
      { original: "Move my 3pm tomorrow to 4" },
      { original: "Move my 3pm to 4 tomorrow" },
      { original: "Move my 3pm to 4 in Tokyo" },
      { original: "Move my 3pm to 4 and rename it" },
      { detailsDate: "2026-10-30" },
      { window: undefined },
      { explicitTarget: true },
    ])
      expect(isRedundantObservedClockQuery({ ...base, ...patch })).toBe(false);
    expect(
      isRedundantObservedClockQuery({
        ...base,
        original: "Please move my 3pm to 4pm.",
      }),
    ).toBe(true);
    expect(() =>
      observedCalendarDayWindow({ ...context, revision: -1 }, original, "UTC"),
    ).toThrow();
  });
  it.each(["Show my events tomorrow", "Show my schedule next month", "Move my 3pm tomorrow to 4", "Move my 3pm next week to 4", "Move my meeting to 4"])("does not replace qualified targets or ordinary reads: %s",text=>{expect(observedCalendarDayWindow(context,{...original,text},"UTC")).toBeUndefined();});
});

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

describe("dedupeCalendarQueries", () => {
  it("keeps non-Latin search queries instead of stripping them as edge noise", () => {
    expect(dedupeCalendarQueries(["치과 예약"])).toEqual(["치과 예약"]);
    expect(dedupeCalendarQueries(["강남역 회의"])).toEqual(["강남역 회의"]);
    expect(dedupeCalendarQueries(["встреча с врачом"])).toEqual([
      "встреча с врачом",
    ]);
    expect(dedupeCalendarQueries(["新宿で歯医者"])).toEqual(["新宿で歯医者"]);
    expect(dedupeCalendarQueries(["회의실 meeting"])).toEqual([
      "회의실 meeting",
    ]);
    expect(dedupeCalendarQueries(["4월 19일 회의"])).toEqual(["4월 19일 회의"]);
  });

  it("still drops planner noise, punctuation-only, and generic queries", () => {
    expect(dedupeCalendarQueries(["!!!"])).toEqual([]);
    expect(dedupeCalendarQueries(["query?:string"])).toEqual([]);
    expect(dedupeCalendarQueries(["calendar"])).toEqual([]);
    expect(dedupeCalendarQueries(["  dentist appointment!! "])).toEqual([
      "dentist appointment",
    ]);
    expect(dedupeCalendarQueries(["2026-04-19"])).toEqual(["2026-04-19"]);
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

  it("resolves Korean and Chinese weekday names, including before particles", () => {
    const friday = { year: 2026, month: 10, day: 16 };
    for (const text of [
      "금요일 15:00",
      "금요일에 치과",
      "이번 주 금요일",
      "星期五",
      "周五",
      "星期五下午三点",
      "viernes",
      "Friday",
    ]) {
      expect(parseExplicitLocalDate(text, ZONE, NOW), text).toEqual(friday);
    }
    expect(parseExplicitLocalDate("三月 15", ZONE, NOW)).toEqual({
      year: 2026,
      month: 3,
      day: 15,
    });
  });

  it("reads Korean and Chinese next-week qualifiers like next friday", () => {
    const nextWeekFriday = { year: 2026, month: 10, day: 23 };
    for (const text of [
      "다음 주 금요일",
      "다음주 금요일 3시",
      "下周五",
      "下星期五下午",
      "下周星期五",
      "下周的星期五",
      "下个星期五",
      "다음 주의 금요일",
    ]) {
      expect(parseExplicitLocalDate(text, ZONE, NOW), text).toEqual(
        nextWeekFriday,
      );
    }
    // The qualifier names the following Monday-start week, so a weekday
    // earlier in the week than today is still in that week.
    for (const text of ["下周一", "다음 주 월요일", "下星期一"]) {
      expect(parseExplicitLocalDate(text, ZONE, NOW), text).toEqual({
        year: 2026,
        month: 10,
        day: 19,
      });
    }
    const sunday = new Date("2026-10-18T03:00:00Z");
    for (const text of ["下周一", "다음 주 월요일"]) {
      expect(parseExplicitLocalDate(text, ZONE, sunday), text).toEqual({
        year: 2026,
        month: 10,
        day: 19,
      });
    }
    // 下下周 / 다다음 주 name the week after next.
    for (const [text, day] of [
      ["下下周一", 26],
      ["下下星期一", 26],
      ["다다음 주 월요일", 26],
      ["下下周五", 30],
      ["下下周日", 1],
    ] as const) {
      expect(parseExplicitLocalDate(text, ZONE, NOW), text).toEqual({
        year: 2026,
        month: day === 1 ? 11 : 10,
        day,
      });
    }
    for (const text of ["这周五", "这周星期五"]) {
      expect(parseExplicitLocalDate(text, ZONE, NOW), text).toEqual({
        year: 2026,
        month: 10,
        day: 16,
      });
    }
  });

  it("does not read a weekday out of Chinese week counts and schedule words", () => {
    for (const text of [
      "一周日程",
      "一周五天",
      "下一周日程",
      "下周日程",
      "这周五天都要加班",
      "两个星期日程",
    ]) {
      expect(parseExplicitLocalDate(text, ZONE, NOW), text).toBeNull();
    }
    expect(parseExplicitLocalDate("下周日", ZONE, NOW)).toEqual({
      year: 2026,
      month: 10,
      day: 25,
    });
    expect(parseExplicitLocalDate("周日下午", ZONE, NOW)).toEqual({
      year: 2026,
      month: 10,
      day: 18,
    });
  });

  it("leaves past and every-week Korean and Chinese weekdays unresolved", () => {
    for (const text of [
      "지난 금요일",
      "지난주 금요일",
      "매주 금요일",
      "上周五",
      "每周五",
      "上周星期五",
      "每周星期五",
      "上周的星期五",
    ]) {
      expect(parseExplicitLocalDate(text, ZONE, NOW), text).toBeNull();
    }
    expect(parseExplicitLocalDate("구매 금요일까지", ZONE, NOW)).toEqual({
      year: 2026,
      month: 10,
      day: 16,
    });
  });

  it("keeps English word boundaries and skips one-syllable Korean words", () => {
    for (const text of [
      "fridays",
      "fridayish",
      "xfriday",
      "friday_x",
      "일정 확인 오후 3시",
      "월급날",
    ]) {
      expect(parseExplicitLocalDate(text, ZONE, NOW), text).toBeNull();
    }
  });
});

// Uses the canonical ALS turn timer; private payload/error identity must never
// become diagnostic metadata or be retried by a timing boundary.
it("keeps Calendar update timing bounded, optional and transparent to cancellation", async () => {
  const secret = "PRIVATE_CALENDAR_payload_account_title_url";
  const value = Object.freeze({ secret });
  const untimed = vi.fn(async () => value);
  expect(await timeCalendarUpdate("source-read", untimed)).toBe(value);
  expect(untimed).toHaveBeenCalledTimes(1);
  const timer = new InferenceTurnTimer({
    turnId: "timing-fixture",
    label: "calendar-update",
    t0EpochMs: 1000,
  });
  const abort = new DOMException(secret, "AbortError");
  const cancelled = vi.fn(async () => {
    throw abort;
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1000);
  try {
    const result = await runWithInferenceTiming(timer, () =>
      timeCalendarUpdate("persist", async () => {
        vi.setSystemTime(1025);
        return value;
      }),
    );
    expect(result).toBe(value);
    await expect(
      runWithInferenceTiming(timer, () =>
        timeCalendarUpdate("availability", cancelled),
      ),
    ).rejects.toBe(abort);
    expect(cancelled).toHaveBeenCalledTimes(1);
    const summary = timer.close();
    expect(summary.spans).toEqual([
      {
        name: "actions:calendar:update:persist",
        startMs: 0,
        endMs: 25,
        durationMs: 25,
        meta: { returned: true },
      },
      {
        name: "actions:calendar:update:availability",
        startMs: 25,
        endMs: 25,
        durationMs: 0,
        meta: { returned: false },
      },
    ]);
    expect(summary.totalMs).toBe(25);
    expect(JSON.stringify(summary.spans)).not.toContain(secret);
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  { date: "2026-03-08", hours: 23 },
  { date: "2026-11-01", hours: 25 },
])(
  "bounds a selected civil day across DST without granting a write: $date",
  ({ date, hours }) => {
    const timeZone = "America/Los_Angeles",
      context = {
        view: "calendar",
        revision: 3,
        sensitive: false,
        timeZone,
        calendarDay: { date, timeZone },
      };
    const original = {
      text: "Move my 3pm to 4",
      observedAt: new Date("2026-10-28T12:00:00Z"),
    };
    const window = observedCalendarDayWindow(context, original, timeZone);
    if (!window) throw Error("Missing selected day window");
    expect((Date.parse(window.end) - Date.parse(window.start)) / 3600000).toBe(
      hours,
    );
    expect(() =>
      observedCalendarDayWindow(
        { ...context, sensitive: true },
        original,
        timeZone,
      ),
    ).toThrow();
    expect(() =>
      observedCalendarDayWindow(
        { ...context, calendarDay: { date: "2026-02-30", timeZone } },
        original,
        timeZone,
      ),
    ).toThrow();
    expect(() => observedCalendarDayWindow(context, original, "UTC")).toThrow();
    expect(
      observedCalendarDayWindow(
        context,
        { ...original, text: "Move my 3pm tomorrow to 4" },
        timeZone,
      ),
    ).toBeUndefined();
  },
);
