/**
 * Reminder-timeliness corpus (#10723) — two simulated 4-day windows that
 * bracket the 2026 US DST transitions, replayed at a 5-minute tick cadence
 * (production ticks every minute; 5 minutes keeps ~2,300 replayed ticks
 * affordable while still bounding worst-case lateness).
 *
 * Every `once`/`cron` case commits its expected occurrence instants by hand.
 * The instants were cross-checked against IANA tzdata (Python `zoneinfo`):
 *
 *  - America/New_York: EST (UTC-5) → EDT (UTC-4) at 2026-03-08 02:00 local
 *    (07:00Z); EDT → EST at 2026-11-01 02:00 local (06:00Z).
 *  - Europe/Berlin: CET (UTC+1) on every day both windows cover (the EU
 *    transitions — 2026-03-29 / 2026-10-25 — fall outside both windows).
 *  - Asia/Kolkata: UTC+5:30 year-round (fractional offset, no DST).
 *  - Australia/Sydney: AEDT (UTC+11) across both windows (southern
 *    hemisphere; AEDT runs 2025-10-05→2026-04-05 and resumes 2026-10-04).
 *
 * Deliberate coverage notes:
 *  - `*-cron-ny-0230` in the spring window pins the vanished-hour contract:
 *    2026-03-08 has no 02:30 local, so that day is SKIPPED (the behavior
 *    pinned by plugin-scheduling's dst-boundaries.test.ts).
 *  - No cron sits inside the REPEATED fall-back hour (01:00–01:59 on
 *    2026-11-01): core's ambiguous-hour double-fire is a known, separately
 *    pinned limit and would force this gate to bake a bug into "expected".
 *  - Cron minutes are deliberately OFF the 5-minute tick grid (:07/:03) so
 *    the deviation metric measures real lateness, not zeroes.
 *  - Weekly cases prove day-of-week schedules survive the transition week
 *    (2026-03-09 and 2026-11-02 are Mondays).
 */

import type { TimelinessCase, TimelinessWindow } from "./oracle.ts";

const springTasks: TimelinessCase[] = [
  {
    id: "s-cron-ny-0907",
    kind: "checkin",
    trigger: { kind: "cron", expression: "7 9 * * *", tz: "America/New_York" },
    expectedOccurrences: [
      "2026-03-07T14:07:00.000Z", // 09:07 EST
      "2026-03-08T13:07:00.000Z", // 09:07 EDT — first post-transition day
      "2026-03-09T13:07:00.000Z",
      "2026-03-10T13:07:00.000Z",
    ],
  },
  {
    id: "s-cron-ny-0800",
    kind: "checkin",
    trigger: { kind: "cron", expression: "0 8 * * *", tz: "America/New_York" },
    expectedOccurrences: [
      "2026-03-07T13:00:00.000Z", // 08:00 EST
      "2026-03-08T12:00:00.000Z", // 08:00 EDT
      "2026-03-09T12:00:00.000Z",
      "2026-03-10T12:00:00.000Z",
    ],
  },
  {
    id: "s-cron-ny-0230",
    kind: "checkin",
    trigger: { kind: "cron", expression: "30 2 * * *", tz: "America/New_York" },
    expectedOccurrences: [
      "2026-03-07T07:30:00.000Z", // 02:30 EST
      // 2026-03-08 02:30 local does not exist (vanished hour) — day skipped.
      "2026-03-09T06:30:00.000Z", // 02:30 EDT
      "2026-03-10T06:30:00.000Z",
    ],
  },
  {
    id: "s-cron-berlin-2103",
    kind: "checkin",
    trigger: { kind: "cron", expression: "3 21 * * *", tz: "Europe/Berlin" },
    expectedOccurrences: [
      "2026-03-07T20:03:00.000Z", // 21:03 CET (UTC+1 all window)
      "2026-03-08T20:03:00.000Z",
      "2026-03-09T20:03:00.000Z",
      "2026-03-10T20:03:00.000Z",
    ],
  },
  {
    id: "s-cron-kolkata-0715",
    kind: "checkin",
    trigger: { kind: "cron", expression: "15 7 * * *", tz: "Asia/Kolkata" },
    expectedOccurrences: [
      "2026-03-07T01:45:00.000Z", // 07:15 IST (UTC+5:30)
      "2026-03-08T01:45:00.000Z",
      "2026-03-09T01:45:00.000Z",
      "2026-03-10T01:45:00.000Z",
    ],
  },
  {
    id: "s-cron-sydney-0900",
    kind: "checkin",
    trigger: { kind: "cron", expression: "0 9 * * *", tz: "Australia/Sydney" },
    expectedOccurrences: [
      "2026-03-07T22:00:00.000Z", // Mar 8 09:00 AEDT (UTC+11)
      "2026-03-08T22:00:00.000Z",
      "2026-03-09T22:00:00.000Z",
      "2026-03-10T22:00:00.000Z",
    ],
  },
  {
    id: "s-cron-weekly-mon",
    kind: "checkin",
    trigger: { kind: "cron", expression: "0 12 * * 1", tz: "UTC" },
    expectedOccurrences: [
      "2026-03-09T12:00:00.000Z", // Monday in the transition week
    ],
  },
  {
    id: "s-once-mid",
    kind: "reminder",
    trigger: { kind: "once", atIso: "2026-03-08T13:02:00.000Z" },
    expectedOccurrences: ["2026-03-08T13:02:00.000Z"],
  },
  {
    id: "s-once-pre-dst",
    kind: "reminder",
    // Two minutes before the 07:00Z spring-forward instant.
    trigger: { kind: "once", atIso: "2026-03-08T06:58:00.000Z" },
    expectedOccurrences: ["2026-03-08T06:58:00.000Z"],
  },
  {
    id: "s-interval-47",
    kind: "reminder",
    // 47 is coprime with the 5-minute grid: ideals walk across tick offsets.
    trigger: {
      kind: "interval",
      everyMinutes: 47,
      from: "2026-03-07T00:03:00.000Z",
    },
  },
  {
    id: "s-interval-360",
    kind: "reminder",
    trigger: { kind: "interval", everyMinutes: 360 },
  },
];

const fallTasks: TimelinessCase[] = [
  {
    id: "f-cron-ny-0907",
    kind: "checkin",
    trigger: { kind: "cron", expression: "7 9 * * *", tz: "America/New_York" },
    expectedOccurrences: [
      "2026-10-31T13:07:00.000Z", // 09:07 EDT
      "2026-11-01T14:07:00.000Z", // 09:07 EST — first post-transition day
      "2026-11-02T14:07:00.000Z",
      "2026-11-03T14:07:00.000Z",
    ],
  },
  {
    id: "f-cron-ny-0800",
    kind: "checkin",
    trigger: { kind: "cron", expression: "0 8 * * *", tz: "America/New_York" },
    expectedOccurrences: [
      "2026-10-31T12:00:00.000Z", // 08:00 EDT
      "2026-11-01T13:00:00.000Z", // 08:00 EST
      "2026-11-02T13:00:00.000Z",
      "2026-11-03T13:00:00.000Z",
    ],
  },
  {
    id: "f-cron-ny-0230",
    kind: "checkin",
    // 02:30 sits AFTER the repeated 01:00–01:59 hour, so it happens exactly
    // once on the transition day (as EST).
    trigger: { kind: "cron", expression: "30 2 * * *", tz: "America/New_York" },
    expectedOccurrences: [
      "2026-10-31T06:30:00.000Z", // 02:30 EDT
      "2026-11-01T07:30:00.000Z", // 02:30 EST
      "2026-11-02T07:30:00.000Z",
      "2026-11-03T07:30:00.000Z",
    ],
  },
  {
    id: "f-cron-berlin-2103",
    kind: "checkin",
    trigger: { kind: "cron", expression: "3 21 * * *", tz: "Europe/Berlin" },
    expectedOccurrences: [
      "2026-10-31T20:03:00.000Z", // 21:03 CET (EU fell back Oct 25)
      "2026-11-01T20:03:00.000Z",
      "2026-11-02T20:03:00.000Z",
      "2026-11-03T20:03:00.000Z",
    ],
  },
  {
    id: "f-cron-kolkata-0715",
    kind: "checkin",
    trigger: { kind: "cron", expression: "15 7 * * *", tz: "Asia/Kolkata" },
    expectedOccurrences: [
      "2026-10-31T01:45:00.000Z",
      "2026-11-01T01:45:00.000Z",
      "2026-11-02T01:45:00.000Z",
      "2026-11-03T01:45:00.000Z",
    ],
  },
  {
    id: "f-cron-sydney-0900",
    kind: "checkin",
    trigger: { kind: "cron", expression: "0 9 * * *", tz: "Australia/Sydney" },
    expectedOccurrences: [
      "2026-10-31T22:00:00.000Z", // Nov 1 09:00 AEDT (UTC+11)
      "2026-11-01T22:00:00.000Z",
      "2026-11-02T22:00:00.000Z",
      "2026-11-03T22:00:00.000Z",
    ],
  },
  {
    id: "f-cron-weekly-mon",
    kind: "checkin",
    trigger: { kind: "cron", expression: "0 12 * * 1", tz: "UTC" },
    expectedOccurrences: [
      "2026-11-02T12:00:00.000Z", // Monday in the transition week
    ],
  },
  {
    id: "f-once-pre-fallback",
    kind: "reminder",
    // Two minutes before the 06:00Z fall-back instant.
    trigger: { kind: "once", atIso: "2026-11-01T05:58:00.000Z" },
    expectedOccurrences: ["2026-11-01T05:58:00.000Z"],
  },
  {
    id: "f-once-mid",
    kind: "reminder",
    trigger: { kind: "once", atIso: "2026-11-02T17:33:00.000Z" },
    expectedOccurrences: ["2026-11-02T17:33:00.000Z"],
  },
  {
    id: "f-interval-47",
    kind: "reminder",
    trigger: {
      kind: "interval",
      everyMinutes: 47,
      from: "2026-10-31T00:03:00.000Z",
    },
  },
  {
    id: "f-interval-360",
    kind: "reminder",
    trigger: { kind: "interval", everyMinutes: 360 },
  },
];

export const TIMELINESS_WINDOWS: TimelinessWindow[] = [
  {
    name: "spring-forward",
    startIso: "2026-03-07T00:00:00.000Z",
    endIso: "2026-03-11T00:00:00.000Z",
    cadenceMinutes: 5,
    tasks: springTasks,
  },
  {
    name: "fall-back",
    startIso: "2026-10-31T00:00:00.000Z",
    endIso: "2026-11-04T00:00:00.000Z",
    cadenceMinutes: 5,
    tasks: fallTasks,
  },
];
