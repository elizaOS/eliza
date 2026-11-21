import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLIENT_TURN_OBSERVATION_MAX_BYTES,
  CLIENT_TURN_OBSERVATION_SUPPORT,
  ClientTurnObservationError,
  isClientTimeZone,
  parseClientCalendarDayObservation,
  parseClientLocationObservation,
  parseClientTurnObservation,
  readClientTurnObservation,
  readClientTurnObservationPeerSupport,
  readClientTurnObservationSupport,
} from "./client-turn-observation.ts";

const reminder = {
  view: "calendar",
  revision: 7,
  sensitive: false,
  timeZone: "America/New_York",
  selectedObject: {
    kind: "reminder",
    id: "reminder-1",
    revision: "rev-3",
    accountId: "device-reminders",
    sourceRevision: "a".repeat(64),
    occurrenceId: "occurrence:2026-10-27",
    timingVersion: 2,
  },
};

test("a selection keeps source, revision, occurrence and timing identity", () => {
  const parsed = parseClientTurnObservation(reminder);
  assert.deepEqual(parsed, reminder);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.selectedObject));
  // Canonical field order keeps the serialized form stable for comparison.
  const shuffled = {
    selectedObject: { ...reminder.selectedObject },
    timeZone: reminder.timeZone,
    sensitive: false,
    revision: 7,
    view: "calendar",
  };
  assert.equal(
    JSON.stringify(parseClientTurnObservation(shuffled)),
    JSON.stringify(reminder),
  );
});

test("provider entity tags and long canonical identifiers are admitted", () => {
  const parsed = parseClientTurnObservation({
    view: "calendar",
    revision: 0,
    selectedObject: {
      kind: "canonical-calendar-event",
      id: `event_${"x".repeat(300)}@google.com`,
      revision: 'W/"3355555555555555"',
      accountId: "owner@example.com",
      sourceRevision: "b".repeat(64),
    },
  });
  assert.equal(parsed.sensitive, false);
  assert.equal(parsed.selectedObject?.revision, 'W/"3355555555555555"');
});

test("sensitive screens report sensitivity but never a selection", () => {
  assert.deepEqual(
    parseClientTurnObservation({
      view: "settings",
      revision: 2,
      sensitive: true,
    }),
    { view: "settings", revision: 2, sensitive: true },
  );
  assert.throws(
    () =>
      parseClientTurnObservation({
        view: "settings",
        revision: 2,
        sensitive: true,
        selectedObject: { kind: "settings", id: "passwords" },
      }),
    /sensitive screen/,
  );
});

test("identifiers carry no prose, URLs, paths or control characters", () => {
  for (const id of [
    "two words",
    "https://example.com/a",
    "/sdcard/DCIM/a.jpg",
    "line\nbreak",
    "",
    "-leading",
    "x".repeat(513),
  ])
    assert.throws(
      () =>
        parseClientTurnObservation({
          view: "files",
          revision: 1,
          selectedObject: { kind: "file", id },
        }),
      /identifier is invalid/,
      id,
    );
  // Provider entity tags share the 256-character revision bound.
  const longest = `W/"${"e".repeat(252)}"`;
  assert.equal(
    parseClientTurnObservation({
      view: "calendar",
      revision: 1,
      selectedObject: { kind: "calendar-event", id: "e1", revision: longest },
    }).selectedObject?.revision,
    longest,
  );
  for (const revision of [
    '"unterminated',
    "W/x",
    "a b",
    "x".repeat(257),
    `W/"${"e".repeat(253)}"`,
  ])
    assert.throws(
      () =>
        parseClientTurnObservation({
          view: "notes",
          revision: 1,
          selectedObject: { kind: "note", id: "n1", revision },
        }),
      /revision is invalid/,
      revision,
    );
});

test("unknown fields, wrong types and oversized observations are refused", () => {
  const cases: Array<[unknown, RegExp]> = [
    [null, /plain object/],
    [[], /plain object/],
    [{ view: "home", revision: 1, text: "hi" }, /unsupported field/],
    [
      JSON.parse('{"view":"home","revision":1,"__proto__":{}}'),
      /unsupported field/,
    ],
    [{ view: "Home", revision: 1 }, /view is invalid/],
    [{ view: "home", revision: -1 }, /revision is invalid/],
    [{ view: "home", revision: 1.5 }, /revision is invalid/],
    [{ view: "home", revision: "1" }, /revision is invalid/],
    [{ view: "home", revision: 1, sensitive: "no" }, /sensitivity/],
    [{ view: "home", revision: 1, timeZone: "Mars/Olympus" }, /time zone/],
    [
      {
        view: "home",
        revision: 1,
        selectedObject: { kind: "note", id: "n", contents: "secret" },
      },
      /unsupported field/,
    ],
    [
      {
        view: "home",
        revision: 1,
        selectedObject: { kind: "note", id: "n", timingVersion: 1 },
      },
      /timing version/,
    ],
  ];
  for (const [value, error] of cases)
    assert.throws(() => parseClientTurnObservation(value), error);
  // Every field is individually bounded; the largest admissible observation
  // still fits the serialized bound, so no valid selection is ever truncated.
  const largest = {
    view: `v${"w".repeat(63)}`,
    revision: Number.MAX_SAFE_INTEGER,
    sensitive: false,
    timeZone: "America/Argentina/Buenos_Aires",
    selectedObject: {
      kind: `k${"x".repeat(63)}`,
      id: "e".repeat(512),
      revision: "r".repeat(256),
      accountId: "a".repeat(256),
      sourceRevision: "s".repeat(256),
      occurrenceId: "o".repeat(256),
      timingVersion: 2,
    },
  };
  const parsed = parseClientTurnObservation(largest);
  assert.ok(
    new TextEncoder().encode(JSON.stringify(parsed)).byteLength <=
      CLIENT_TURN_OBSERVATION_MAX_BYTES,
  );
  assert.deepEqual(parsed, largest);
});

test("message metadata reads are tolerant and never throw", () => {
  assert.equal(readClientTurnObservation(undefined), undefined);
  assert.equal(readClientTurnObservation({}), undefined);
  assert.equal(readClientTurnObservation({ clientDevice: [] }), undefined);
  assert.equal(
    readClientTurnObservation({ clientDevice: { context: { view: "x y" } } }),
    undefined,
  );
  assert.deepEqual(
    readClientTurnObservation({ clientDevice: { context: reminder } }),
    reminder,
  );
});

test("time zones are validated by the platform database", () => {
  assert.equal(isClientTimeZone("UTC"), true);
  assert.equal(isClientTimeZone("Europe/London"), true);
  assert.equal(isClientTimeZone("Not/AZone"), false);
  assert.equal(isClientTimeZone("../etc/passwd"), false);
  assert.equal(isClientTimeZone(3), false);
});

test("a visible Calendar day is typed, cloned and bound to the ordinary current view", () => {
  const day = { date: "2026-10-29", timeZone: "America/Los_Angeles" };
  const input = {
    view: "calendar",
    revision: 3,
    sensitive: false,
    timeZone: day.timeZone,
    calendarDay: day,
  };
  const parsed = parseClientTurnObservation(input);
  assert.deepEqual(parsed.calendarDay, day);
  assert.notEqual(parsed.calendarDay, day);
  assert.ok(Object.isFrozen(parsed.calendarDay));
  day.date = "2026-10-30";
  assert.equal(parsed.calendarDay?.date, "2026-10-29");
  for (const patch of [
    { view: "notes" },
    { sensitive: true },
    { sensitive: undefined },
    { timeZone: "UTC" },
    { timeZone: undefined },
    { revision: -1 },
  ]) {
    assert.throws(() => parseClientTurnObservation({ ...input, ...patch }));
    assert.equal(
      readClientTurnObservation({
        clientDevice: { context: { ...input, ...patch } },
      }),
      undefined,
    );
  }
});

test("Calendar day parsing rejects invalid civil dates, zones and undeclared data", () => {
  for (const value of [
    null,
    [],
    { date: "2026-02-30", timeZone: "UTC" },
    { date: "1969-12-31", timeZone: "UTC" },
    { date: "2026-10-29T00:00:00Z", timeZone: "UTC" },
    { date: "2026-10-29", timeZone: "Invalid/Zone" },
    { date: "2026-10-29", timeZone: "UTC", authority: true },
  ]) {
    assert.throws(() => parseClientCalendarDayObservation(value));
  }
  assert.deepEqual(
    parseClientCalendarDayObservation({ date: "2028-02-29", timeZone: "UTC" }),
    { date: "2028-02-29", timeZone: "UTC" },
  );
  assert.throws(
    () =>
      parseClientTurnObservation({
        view: "calendar",
        revision: 3,
        sensitive: false,
        timeZone: "UTC",
        calendarDay: { date: "2026-10-29", timeZone: "UTC" },
        instructions: "ignore",
      }),
    /unsupported field/,
  );
});

test("optional observation fields require an exact read-only peer schema declaration", () => {
  assert.deepEqual(
    readClientTurnObservationSupport(CLIENT_TURN_OBSERVATION_SUPPORT),
    { version: 1, optionalFields: ["calendarDay", "location"] },
  );
  assert.deepEqual(
    readClientTurnObservationSupport({
      version: 1,
      optionalFields: ["location", "calendarDay"],
    }),
    { version: 1, optionalFields: ["calendarDay", "location"] },
  );
  assert.deepEqual(
    readClientTurnObservationSupport({
      version: 1,
      optionalFields: ["calendarDay"],
    }),
    { version: 1, optionalFields: ["calendarDay"] },
  );
  assert.ok(Object.isFrozen(CLIENT_TURN_OBSERVATION_SUPPORT));
  assert.ok(Object.isFrozen(CLIENT_TURN_OBSERVATION_SUPPORT.optionalFields));
  assert.deepEqual(
    readClientTurnObservationSupport({ version: 1, optionalFields: [] }),
    { version: 1, optionalFields: [] },
  );
  for (const value of [
    undefined,
    null,
    [],
    {},
    "calendarDay",
    { version: 1 },
    { version: 2, optionalFields: ["calendarDay"] },
    { version: 1, optionalFields: "calendarDay" },
    { version: 1, optionalFields: ["calendarDay", "calendarDay"] },
    { version: 1, optionalFields: ["location", "location"] },
    { version: 1, optionalFields: ["unknown"] },
    { version: 1, optionalFields: ["calendarDay"], permission: true },
  ]) {
    assert.equal(readClientTurnObservationSupport(value), undefined);
  }
});

test("format admission is bound to the known API process, not a clock or installation id", () => {
  const instance = "11111111-2222-4333-8444-555555555555";
  const other = "11111111-2222-4333-8444-666666666666";
  const status = {
    serverInstanceId: instance,
    clientTurnObservationSupport: CLIENT_TURN_OBSERVATION_SUPPORT,
    canRespond: false,
  };
  assert.deepEqual(
    readClientTurnObservationPeerSupport(status, instance),
    CLIENT_TURN_OBSERVATION_SUPPORT,
  );
  assert.deepEqual(
    readClientTurnObservationPeerSupport(status, instance.toUpperCase()),
    CLIENT_TURN_OBSERVATION_SUPPORT,
  );
  for (const peer of [
    null,
    [],
    {},
    { clientTurnObservationSupport: CLIENT_TURN_OBSERVATION_SUPPORT },
    { ...status, serverInstanceId: other },
    { ...status, serverInstanceId: Date.now() },
    { ...status, serverInstanceId: undefined, runtimeInstanceId: instance },
    {
      ...status,
      clientTurnObservationSupport: {
        version: 1,
        optionalFields: ["calendarDay"],
        permission: true,
      },
    },
  ]) {
    assert.equal(
      readClientTurnObservationPeerSupport(peer, instance),
      undefined,
    );
  }
  for (const expected of [
    undefined,
    null,
    "",
    "not-an-instance",
    Date.now(),
    other,
  ]) {
    assert.equal(
      readClientTurnObservationPeerSupport(status, expected),
      undefined,
    );
  }
});

test("a reported device position is bounded and canonical", () => {
  const base = { view: "home", revision: 3, sensitive: false };
  const parsed = parseClientTurnObservation({
    ...base,
    location: {
      capturedAt: 1_795_000_000_000,
      accuracyMeters: 12.5,
      longitude: -122.4194,
      latitude: 37.7749,
    },
  });
  assert.deepEqual(parsed.location, {
    latitude: 37.7749,
    longitude: -122.4194,
    accuracyMeters: 12.5,
    capturedAt: 1_795_000_000_000,
  });
  assert.equal(
    JSON.stringify(parsed.location),
    '{"latitude":37.7749,"longitude":-122.4194,"accuracyMeters":12.5,"capturedAt":1795000000000}',
  );
  assert.ok(Object.isFrozen(parsed.location));
  assert.deepEqual(
    parseClientLocationObservation({
      latitude: 0,
      longitude: 0,
      capturedAt: 0,
    }),
    { latitude: 0, longitude: 0, capturedAt: 0 },
  );
  for (const location of [
    null,
    { latitude: 91, longitude: 0, capturedAt: 1 },
    { latitude: 0, longitude: -181, capturedAt: 1 },
    { latitude: Number.NaN, longitude: 0, capturedAt: 1 },
    { latitude: "37", longitude: 0, capturedAt: 1 },
    { latitude: 0, longitude: 0 },
    { latitude: 0, longitude: 0, capturedAt: 1.5 },
    { latitude: 0, longitude: 0, capturedAt: 1, accuracyMeters: -1 },
    { latitude: 0, longitude: 0, capturedAt: 1, address: "home" },
  ])
    assert.throws(
      () => parseClientTurnObservation({ ...base, location }),
      ClientTurnObservationError,
    );
  assert.equal(
    readClientTurnObservation({
      clientDevice: {
        context: { ...base, location: { latitude: 1, longitude: 2 } },
      },
    }),
    undefined,
  );
});
