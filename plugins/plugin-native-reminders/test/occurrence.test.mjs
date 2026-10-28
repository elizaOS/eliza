import assert from "node:assert/strict";
import test from "node:test";
import {
  completeReminderOccurrence,
  initialReminderDue,
  nextReminderOccurrence,
  REMINDER_HISTORY_LIMIT,
  REMINDER_SNOOZE_MS,
  snoozeReminderOccurrence,
} from "../src/occurrence.ts";

const MINUTE = 60_000;
const rule = (extra = {}) => ({
  rule: "daily",
  zone: "America/New_York",
  date: "2026-03-06",
  time: "09:00",
  leadMinutes: 0,
  ...extra,
});
const host = (now, extra = {}) => {
  let n = 0;
  return {
    now,
    alertStatus: "scheduled",
    nextOccurrenceId: () => `next-${++n}`,
    ...extra,
  };
};

test("a new repeat resolves its saved civil time in the saved zone", () => {
  // 09:00 EST is 14:00Z.
  const due = Date.parse("2026-03-06T14:00:00Z");
  assert.equal(initialReminderDue(rule(), due), due);
  assert.equal(
    initialReminderDue(rule({ leadMinutes: 15 }), due - 15 * MINUTE),
    due,
  );
  assert.throws(
    () => initialReminderDue(rule(), due + MINUTE),
    /does not match reminder time/,
  );
  // 2026-03-08 is a Sunday.
  assert.throws(
    () =>
      initialReminderDue(
        rule({ rule: "weekdays", date: "2026-03-08" }),
        Date.parse("2026-03-08T13:00:00Z"),
      ),
    /weekday/,
  );
  // 02:30 does not exist on the spring-forward date.
  assert.throws(
    () =>
      initialReminderDue(
        rule({ date: "2026-03-08", time: "02:30" }),
        Date.parse("2026-03-08T07:30:00Z"),
      ),
    /does not exist/,
  );
  // 01:30 happens twice on the fall-back date; the earlier instant is used.
  assert.equal(
    initialReminderDue(
      rule({ date: "2026-11-01", time: "01:30" }),
      Date.parse("2026-11-01T05:30:00Z"),
    ),
    Date.parse("2026-11-01T05:30:00Z"),
  );
});

test("malformed repeat rules fail closed", () => {
  for (const bad of [
    rule({ rule: "monthly" }),
    rule({ leadMinutes: -1 }),
    rule({ leadMinutes: 10081 }),
    rule({ leadMinutes: 1.5 }),
    rule({ date: "2026-02-30" }),
    rule({ time: "9:00" }),
    rule({ zone: "Mars/Base" }),
  ])
    assert.throws(() => nextReminderOccurrence(bad, Date.now()));
  assert.throws(() => nextReminderOccurrence(rule(), Number.NaN));
});

test("the next repeat crosses DST in wall time and counts skipped dates", () => {
  // Completed on Monday morning after missing Saturday and Sunday.
  const now = Date.parse("2026-03-09T12:00:00Z");
  const next = nextReminderOccurrence(rule(), now);
  // 09:00 EDT is 13:00Z after the spring-forward weekend.
  assert.deepEqual(next, {
    dueAt: Date.parse("2026-03-09T13:00:00Z"),
    at: Date.parse("2026-03-09T13:00:00Z"),
    date: "2026-03-09",
    skippedDates: 2,
  });
  const weekdays = nextReminderOccurrence(
    rule({ rule: "weekdays" }),
    Date.parse("2026-03-06T15:00:00Z"),
  );
  assert.equal(weekdays.date, "2026-03-09");
  assert.equal(weekdays.skippedDates, 0);
  const weekly = nextReminderOccurrence(
    rule({ rule: "weekly", leadMinutes: 30 }),
    Date.parse("2026-03-06T15:00:00Z"),
  );
  assert.equal(weekly.date, "2026-03-13");
  assert.equal(weekly.at, weekly.dueAt - 30 * MINUTE);
  // A future gap advances to the first valid wall time after it.
  const gap = nextReminderOccurrence(
    rule({ date: "2026-03-07", time: "02:30" }),
    Date.parse("2026-03-07T12:00:00Z"),
  );
  assert.equal(gap.date, "2026-03-08");
  assert.equal(gap.dueAt, Date.parse("2026-03-08T07:00:00Z"));
});

test("Done completes a one-off reminder with one history entry", () => {
  const now = Date.parse("2026-03-06T15:00:00Z");
  const row = {
    status: "posted",
    at: Date.parse("2026-03-06T14:00:00Z"),
    dueAt: Date.parse("2026-03-06T14:00:00Z"),
    occurrenceId: "first",
    history: [],
    postedAt: now - MINUTE,
    snoozedAt: now - 2 * MINUTE,
    legacyAlarm: true,
  };
  assert.equal(completeReminderOccurrence(row, host(now)), "completed");
  assert.equal(row.status, "completed");
  assert.equal(row.completedAt, now);
  assert.equal(row.occurrenceId, "first");
  assert.deepEqual(row.history, [
    {
      occurrenceId: "first",
      dueAt: Date.parse("2026-03-06T14:00:00Z"),
      completedAt: now,
      skippedDates: 0,
    },
  ]);
  assert.equal("postedAt" in row, false);
  assert.equal("snoozedAt" in row, false);
  assert.equal("legacyAlarm" in row, false);
  assert.throws(
    () => completeReminderOccurrence(row, host(now)),
    /no longer active/,
  );
});

test("Done advances a repeat to its next occurrence and keeps its alert state", () => {
  const now = Date.parse("2026-03-09T12:00:00Z");
  const row = {
    status: "posted",
    at: Date.parse("2026-03-06T14:00:00Z"),
    dueAt: Date.parse("2026-03-06T14:00:00Z"),
    recurrence: rule(),
    occurrenceId: "friday",
    history: Array.from({ length: REMINDER_HISTORY_LIMIT }, (_, i) => ({
      occurrenceId: `old-${i}`,
      dueAt: i,
      completedAt: i,
      skippedDates: 0,
    })),
    postedAt: now - MINUTE,
    completedAt: 1,
  };
  assert.equal(
    completeReminderOccurrence(
      row,
      host(now, { alertStatus: "permission-denied" }),
    ),
    "permission-denied",
  );
  assert.equal(row.recurrence.date, "2026-03-09");
  assert.equal(row.dueAt, Date.parse("2026-03-09T13:00:00Z"));
  assert.equal(row.at, row.dueAt);
  assert.equal(row.occurrenceId, "next-1");
  assert.equal("completedAt" in row, false);
  assert.equal("postedAt" in row, false);
  assert.equal(row.history.length, REMINDER_HISTORY_LIMIT);
  assert.equal(row.history[0].occurrenceId, "old-1");
  assert.deepEqual(row.history.at(-1), {
    occurrenceId: "friday",
    dueAt: Date.parse("2026-03-06T14:00:00Z"),
    completedAt: now,
    skippedDates: 2,
  });
  const silent = {
    status: "pending",
    at: Date.parse("2026-03-06T14:00:00Z"),
    dueAt: Date.parse("2026-03-06T14:00:00Z"),
    alertMinutes: null,
    recurrence: rule(),
    occurrenceId: "silent",
  };
  assert.equal(completeReminderOccurrence(silent, host(now)), "pending");
});

test("Snooze delays alerting reminders only once while scheduled", () => {
  const now = Date.parse("2026-03-06T15:00:00Z");
  const row = {
    status: "posted",
    at: now - MINUTE,
    occurrenceId: "a",
    legacyAlarm: true,
  };
  assert.equal(snoozeReminderOccurrence(row, host(now)), "scheduled");
  assert.equal(row.at, now + REMINDER_SNOOZE_MS);
  assert.equal(row.snoozedAt, now);
  assert.equal("legacyAlarm" in row, false);
  assert.equal(snoozeReminderOccurrence(row, host(now + 1)), "unchanged");
  assert.throws(
    () =>
      snoozeReminderOccurrence(
        { status: "pending", at: now, alertMinutes: null, occurrenceId: "b" },
        host(now),
      ),
    /cannot be snoozed/,
  );
  assert.throws(
    () =>
      snoozeReminderOccurrence(
        { status: "cancelled", at: now, occurrenceId: "c" },
        host(now),
      ),
    /no longer active/,
  );
  assert.throws(
    () =>
      completeReminderOccurrence(
        { status: "todo", at: now, undated: true, occurrenceId: "d" },
        host(now),
      ),
    /to-do/,
  );
});

test("Done fails closed for a legacy row without an occurrence id and leaves it unchanged", () => {
  const now = Date.parse("2026-03-06T15:00:00Z");
  const row = {
    status: "posted",
    at: Date.parse("2026-03-06T14:00:00Z"),
    dueAt: Date.parse("2026-03-06T14:00:00Z"),
    history: [],
    postedAt: now - MINUTE,
  };
  const before = structuredClone(row);
  assert.throws(
    () => completeReminderOccurrence(row, host(now)),
    /current reminder occurrence/,
  );
  assert.deepEqual(row, before);
});
