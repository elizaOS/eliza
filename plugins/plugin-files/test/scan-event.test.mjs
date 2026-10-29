import assert from "node:assert/strict";
import test from "node:test";
import {
  reviewScanAllDayEvent,
  reviewScanEvent,
  suggestScanEvent,
  suggestScanEventDetails,
} from "../src/documents/scan-event.ts";

// Node-level coverage of every poster inference rule (J01). Suggestions never authorize saving:
// the reviewed proposal is validated here and the host's own calendar review and Save write it.
test("scan event suggestions preserve text and leave ambiguous dates or time zones for review", () => {
  assert.deepEqual(
    suggestScanEvent("Open studio\n2026-10-10\n18:30\nMain hall"),
    {
      title: "Open studio",
      date: "2026-10-10",
      time: "18:30",
      minutes: 60,
      location: "",
    },
  );
  for (const text of [
    "Tomorrow at 7",
    "July 3 at 7 PM",
    "2026-10-10\n2026-10-11\n07:00 PM",
    "2026-10-10T18:30Z",
    "2026-10-10\n18:30 PST",
    "Meet at 18:30-19:30",
  ])
    assert.equal(suggestScanEvent(text).time, "");
  assert.equal(suggestScanEvent("2026-10-10\n2026-10-11").date, "");
});
test("a reviewed event keeps its civil date across month/year boundaries without writing an event", () => {
  const proposal = reviewScanEvent(
    {
      title: " Reviewed event ",
      date: "2027-01-02",
      time: "23:45",
      minutes: 90,
      location: " Hall ",
    },
    "Exact reviewed OCR text",
    new Date(2026, 11, 31, 12),
  );
  assert.deepEqual(proposal, {
    title: "Reviewed event",
    location: "Hall",
    notes: "Exact reviewed OCR text",
    repeat: "none",
    date: "2027-01-02",
    dayOffset: 2,
    allDay: false,
    time: "23:45",
    minutes: 90,
  });
});
test("invalid dates, missing times and durations cannot become calendar drafts", () => {
  assert.throws(
    () =>
      reviewScanEvent(
        {
          title: "Event",
          date: "2026-10-10",
          time: "18:30",
          minutes: 60,
          location: "",
        },
        "x".repeat(16001),
      ),
    /16,000/,
  );
  const valid = {
    title: "Event",
    date: "2026-10-10",
    time: "18:30",
    minutes: 60,
    location: "",
  };
  for (const patch of [
    { title: "" },
    { date: "2026-02-30" },
    { date: "2026-13-01" },
    { date: "1969-12-31" },
    { date: "" },
    { time: "24:00" },
    { time: "" },
    { minutes: 0 },
    { minutes: 15.5 },
    { minutes: 1441 },
  ])
    assert.throws(() => reviewScanEvent({ ...valid, ...patch }, "text"));
});

test("English poster dates and AM/PM suggestions retain explicit civil meaning", () => {
  for (const date of [
    "October 10, 2026",
    "10 October 2026",
    "Oct. 10th, 2026",
    "10th Oct. 2026",
  ]) {
    const result = suggestScanEvent(
      `Open studio\n${date}\nTime: 6:30 p.m.\nVenue: Main hall`,
    );
    assert.deepEqual(result, {
      title: "Open studio",
      date: "2026-10-10",
      time: "18:30",
      minutes: 60,
      location: "Main hall",
    });
  }
  assert.equal(suggestScanEvent("Event\n2026-10-10\n12 AM").time, "00:00");
  assert.equal(suggestScanEvent("Event\n2026-10-10\n12 PM").time, "12:00");
  assert.equal(
    suggestScanEvent("Event\n2026-10-10\nStart: 7 PM").time,
    "19:00",
  );
  assert.equal(
    suggestScanEvent("Event\n2026-10-10\nLocation: A\nVenue: B").location,
    "",
  );
});
test("poster extraction does not invent years or accept conflicting, invalid or zoned times", () => {
  for (const date of [
    "October 10",
    "10/11/2026",
    "February 30, 2026",
    "2026-02-30",
    "2026-10-10\n11/10/2026",
    "2026-10-10\nOctober 11",
    "October 10, 2026\n11 October 2026",
  ])
    assert.equal(suggestScanEvent(`Event\n${date}`).date, "", date);
  for (const time of [
    "0 PM",
    "13 AM",
    "18:30\n19:00",
    "18:30\n25:00",
    "18:30\n19:7",
    "Time: 6 PM PST",
    "18:30\nTimezone: America/New_York",
    "18:30\nUTC",
    "18:30\nTimezone: Unknown",
    "18:30\nET",
    "2026-10-10T18:30+02:00",
  ])
    assert.equal(suggestScanEvent(`Event\n2026-10-10\n${time}`).time, "", time);
  assert.equal(
    suggestScanEvent("Event\nFebruary 29, 2028\n7 PM").date,
    "2028-02-29",
  );
  assert.equal(suggestScanEvent("Event\nFebruary 29, 2027\n7 PM").date, "");
});

test("ordinary website paths and band names are not mistaken for time zones", () => {
  assert.equal(
    suggestScanEvent(
      "AC/DC tribute\nOctober 10, 2026\n6 PM\nhttps://example.com/events",
    ).time,
    "18:00",
  );
});

test("explicit same-day poster time ranges suggest duration without inventing meridiem or overnight dates", () => {
  for (const range of [
    "6 PM - 8 PM",
    "6PM-8PM",
    "6 p.m. – 8 p.m.",
    "18:00—20:00",
    "18:00 to 20:00",
  ]) {
    const fields = suggestScanEvent(`Studio\nOctober 10, 2026\nTime: ${range}`);
    assert.equal(fields.time, "18:00", range);
    assert.equal(fields.minutes, 120, range);
  }
  for (const range of [
    "6 - 8 PM",
    "11 PM - 1 AM",
    "18:00 - 18:00",
    "18:00 - 18:10",
    "18:00 - 25:00",
    "6 PM - 8 PM PST",
    "18:00 - 20:00\n18:00 - 21:00",
  ]) {
    const fields = suggestScanEvent(`Studio\nOctober 10, 2026\nTime: ${range}`);
    assert.equal(fields.time, "", range);
    assert.equal(fields.minutes, 60, range);
  }
});

// Saturday 2026-10-03 at 15:00 UTC; inference is relative to this injected instant and zone, never to the wall clock.
const now = new Date("2026-10-03T15:00:00Z"),
  ny = { now, timeZone: "America/New_York" },
  london = { now, timeZone: "Europe/London" };
const details = (text, context = ny) => suggestScanEventDetails(text, context);
test("year-less dates suggest their next occurrence with a year-inferred disclosure", () => {
  let r = details("Open studio\nOctober 10\n7 PM");
  assert.equal(r.fields.date, "2026-10-10");
  assert.equal(r.fields.time, "19:00");
  assert.match(r.disclosures.join("\n"), /Year inferred/);
  r = details("Gala\n2 March\n7 PM");
  assert.equal(r.fields.date, "2027-03-02");
  assert.match(r.disclosures.join("\n"), /Year inferred.*2027-03-02/);
  r = details("Fair\nSept 5\n6 PM");
  assert.equal(r.fields.date, "2027-09-05");
  assert.match(r.disclosures.join("\n"), /Year inferred.*2027-09-05/);
  r = details("Fair\n5 Sept\n6 PM");
  assert.equal(r.fields.date, "2027-09-05");
  r = details("Fair\nSept. 5\n6 PM");
  assert.equal(r.fields.date, "2027-09-05");
  r = details("Fair\nOctober 3\n7 PM");
  assert.equal(
    r.fields.date,
    "2026-10-03",
    "today still counts as the next occurrence",
  );
  r = details("Leap gala\nFebruary 29\n7 PM");
  assert.equal(r.fields.date, "2028-02-29");
  assert.equal(
    suggestScanEvent("Event\nOctober 10").date,
    "",
    "without an injected now no year is invented",
  );
  r = details("Event\nOctober 10, 2026\nOctober 11");
  assert.equal(r.fields.date, "", "conflicting dates stay blank");
});
test("weekday, today and tomorrow resolve against the injected now and are disclosed", () => {
  let r = details("Book club\nTuesday\n6:30 PM");
  assert.equal(r.fields.date, "2026-10-06");
  assert.equal(r.fields.time, "18:30");
  assert.match(
    r.disclosures.join("\n"),
    /Tuesday.*next occurrence, 2026-10-06/,
  );
  r = details("Market\nSaturday\n9 AM");
  assert.equal(r.fields.date, "2026-10-03");
  assert.match(r.disclosures.join("\n"), /\(today\)/);
  r = details("Party\nTomorrow\n8 PM");
  assert.equal(r.fields.date, "2026-10-04");
  assert.match(r.disclosures.join("\n"), /Tomorrow.*2026-10-04/);
  r = details("Talk\nToday\n20:00");
  assert.equal(r.fields.date, "2026-10-03");
  r = details("Late talk\nToday\n20:00", {
    now: new Date("2026-10-04T02:00:00Z"),
    timeZone: "America/New_York",
  });
  assert.equal(
    r.fields.date,
    "2026-10-03",
    "today is the civil day in the device zone",
  );
  r = details("Late talk\nToday\n20:00", {
    now: new Date("2026-10-04T02:00:00Z"),
    timeZone: "Europe/London",
  });
  assert.equal(r.fields.date, "2026-10-04");
  r = details("Event\nSaturday, October 10, 2026\n7 PM");
  assert.equal(
    r.fields.date,
    "2026-10-10",
    "a matching weekday confirms the date",
  );
  r = details("Event\nFriday, October 10, 2026\n7 PM");
  assert.equal(r.fields.date, "");
  assert.match(r.disclosures.join("\n"), /does not match/);
  r = details("Event\nTomorrow\nOctober 10, 2026");
  assert.equal(
    r.fields.date,
    "",
    "relative and explicit dates that disagree stay blank",
  );
  r = details("Event\nMonday or Tuesday\n7 PM");
  assert.equal(r.fields.date, "");
  assert.equal(
    details("Tomorrow at 7").fields.time,
    "",
    "a time without AM/PM is never guessed",
  );
});
test("explicit IANA and offset zones convert to the device zone and keep the source zone visible", () => {
  let r = details("Launch\nOctober 10, 2026\n18:30\nTime zone: Europe/London");
  assert.equal(r.fields.date, "2026-10-10");
  assert.equal(r.fields.time, "13:30");
  assert.equal(r.sourceZone, "Europe/London");
  assert.match(
    r.disclosures.join("\n"),
    /Converted from 18:30 Europe\/London.*13:30.*America\/New_York/,
  );
  r = details("Launch\nOctober 10, 2026\n7 PM (Asia/Tokyo)");
  assert.equal(r.fields.date, "2026-10-10");
  assert.equal(r.fields.time, "06:00");
  assert.equal(r.sourceZone, "Asia/Tokyo");
  r = details("Launch\nOctober 10, 2026\n1 AM UTC");
  assert.equal(
    r.fields.date,
    "2026-10-09",
    "conversion can move the civil date",
  );
  assert.equal(r.fields.time, "21:00");
  assert.equal(r.sourceZone, "UTC");
  r = details("Launch\n2026-10-10T18:30+02:00");
  assert.equal(r.fields.date, "2026-10-10");
  assert.equal(r.fields.time, "12:30");
  assert.equal(r.sourceZone, "+02:00");
  r = details("Launch\n2026-10-10\n18:30 UTC+5:30", london);
  assert.equal(r.fields.time, "14:00");
  assert.equal(r.sourceZone, "UTC+5:30");
  r = details("Launch\n2026-10-10T18:30Z", london);
  assert.equal(r.fields.time, "19:30");
  r = details("Launch\nOctober 10, 2026\n6 PM - 8 PM UTC");
  assert.equal(r.fields.time, "14:00");
  assert.equal(r.fields.minutes, 120);
});
test("zone abbreviations, conflicting zones and undated or nonexistent zoned times stay blank", () => {
  for (const text of [
    "Event\n2026-10-10\n6 PM PST",
    "Event\n2026-10-10\n18:30 ET",
    "Event\n2026-10-10\n18:30\nTimezone: Unknown",
    "Event\n2026-10-10\n18:30 UTC\nTime zone: Asia/Tokyo",
    "Event\n18:30 UTC",
    "Event\n2026-03-08\n02:30\nTime zone: America/New_York",
    "Event\n2026-11-01\n01:30\nTime zone: America/New_York",
  ]) {
    const r = details(text);
    assert.equal(r.fields.time, "", text);
    assert.equal(r.sourceZone, null, text);
    assert.ok(r.disclosures.length > 0, text);
  }
  assert.equal(
    details("AC/DC tribute\nOctober 10, 2026\n6 PM\nhttps://example.com/events")
      .fields.time,
    "18:00",
  );
});
test("a dated poster without a time is suggested all-day, but a scan draft never saves an all-day event silently", () => {
  const r = details("Book fair\nOctober 10, 2026\nVenue: Library");
  assert.equal(r.allDay, true);
  assert.equal(r.fields.time, "");
  assert.equal(r.fields.location, "Library");
  assert.match(r.disclosures.join("\n"), /all-day/);
  for (const text of [
    "Book fair\nOctober 10, 2026\n7 PM",
    "Book fair\nOctober 10, 2026 at 7",
    "Book fair\nOctober 10, 2026\nNoon",
    "Book fair",
  ])
    assert.equal(details(text).allDay, false, text);
  assert.throws(
    () =>
      reviewScanEvent(
        {
          title: "Book fair",
          date: "2026-10-10",
          time: "",
          minutes: 60,
          location: "",
          allDay: true,
        },
        "text",
        new Date(2026, 9, 3),
      ),
    /need a start time/,
  );
});
test("repeat wording is only an opt-in hint; drafts repeat only when explicitly confirmed", () => {
  const r = details("Yoga\nEvery Tuesday\n6 PM");
  assert.deepEqual(r.recurrence, {
    repeat: "weekly",
    evidence: "Every Tuesday",
  });
  assert.equal(r.fields.date, "2026-10-06");
  assert.match(r.disclosures.join("\n"), /off until you turn it on/);
  assert.equal(
    details("Standup\nMonday to Friday\n9 AM").recurrence.repeat,
    "weekdays",
  );
  assert.equal(
    details("Run club\nOctober 10, 2026\nDaily at 7 AM").recurrence.repeat,
    "daily",
  );
  assert.equal(
    details("Board meeting\nOctober 10, 2026\nMonthly\n7 PM").recurrence,
    null,
  );
  assert.match(
    details("Board meeting\nOctober 10, 2026\nMonthly\n7 PM").disclosures.join(
      "\n",
    ),
    /not a repeat this draft supports/,
  );
  assert.equal(details("Open studio\nOctober 10, 2026\n7 PM").recurrence, null);
  const fields = {
    title: "Yoga",
    date: "2026-10-06",
    time: "18:00",
    minutes: 60,
    location: "",
  };
  assert.equal(
    reviewScanEvent(fields, "text", new Date(2026, 9, 3)).repeat,
    "none",
  );
  assert.equal(
    reviewScanEvent(
      { ...fields, repeat: "weekly" },
      "text",
      new Date(2026, 9, 3),
    ).repeat,
    "weekly",
  );
  assert.throws(() =>
    reviewScanEvent({ ...fields, repeat: "monthly" }, "text"),
  );
});
test("ambiguous numeric dates stay blank with an explanation even with a reference date", () => {
  for (const text of ["Event\n10/11/2026\n7 PM", "Event\n10-11-26\n7 PM"]) {
    const r = details(text);
    assert.equal(r.fields.date, "", text);
    assert.match(r.disclosures.join("\n"), /numeric date/);
  }
});
test("an OCR line with an ambiguous numeric date and a zone abbreviation leaves date and time blank, saying why", () => {
  const r = details("Open studio\n10/11/2026 7 PM EST\nVenue: Main hall");
  assert.equal(r.fields.date, "");
  assert.equal(r.fields.time, "");
  assert.equal(r.fields.location, "Main hall");
  assert.equal(r.sourceZone, null);
  assert.match(
    r.disclosures.join("\n"),
    /numeric date such as 10\/11.*Enter the date yourself/,
  );
  assert.match(
    r.disclosures.join("\n"),
    /Time zone “EST” is ambiguous\. Enter the local start time yourself\./,
  );
  const weekday = details("Open studio\nFriday, October 10, 2026\n7 PM");
  assert.equal(weekday.fields.date, "");
  assert.match(
    weekday.disclosures.join("\n"),
    /“Friday” does not match the printed date/,
  );
});

test("an all-day suggestion becomes an all-day proposal, never a save", () => {
  const now = new Date(2026, 9, 3, 15),
    suggested = suggestScanEventDetails(
      "Book fair\nOctober 10, 2026\nVenue: Library",
      { now },
    );
  assert.equal(suggested.allDay, true);
  const proposal = reviewScanAllDayEvent(
    {
      title: suggested.fields.title,
      date: suggested.fields.date,
      location: suggested.fields.location,
    },
    "Book fair text",
    now,
  );
  assert.deepEqual(proposal, {
    title: "Book fair",
    location: "Library",
    notes: "Book fair text",
    repeat: "none",
    date: "2026-10-10",
    dayOffset: 7,
    allDay: true,
  });
  assert.equal(
    reviewScanAllDayEvent(
      { title: "Fair", date: "2026-10-10", location: "", repeat: "weekly" },
      "",
      now,
    ).repeat,
    "weekly",
  );
});
test("all-day proposals validate the date, text and repeat", () => {
  const now = new Date(2026, 9, 3);
  for (const date of ["", "2026-02-30", "1969-12-31", "10/10/2026"])
    assert.throws(() =>
      reviewScanAllDayEvent({ title: "Fair", date, location: "" }, "", now),
    );
  assert.throws(
    () =>
      reviewScanAllDayEvent(
        { title: " ", date: "2026-10-10", location: "" },
        "",
        now,
      ),
    /title/,
  );
  assert.throws(
    () =>
      reviewScanAllDayEvent(
        { title: "Fair", date: "2026-10-10", location: "", repeat: "monthly" },
        "",
        now,
      ),
    /repeat/,
  );
  assert.throws(
    () =>
      reviewScanAllDayEvent(
        { title: "Fair", date: "2026-10-10", location: "" },
        "x".repeat(16001),
        now,
      ),
    /16,000/,
  );
});
