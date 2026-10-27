import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLIENT_TURN_OBSERVATION_MAX_BYTES,
  isClientTimeZone,
  parseClientTurnObservation,
  readClientTurnObservation,
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
  for (const revision of ['"unterminated', "W/x", "a b", "x".repeat(257)])
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
