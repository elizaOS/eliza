import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStatedClockTimes } from "./stated-clock-time.ts";

const one = (hour: number, minute: number) => ({
  kind: "one",
  start: { hour, minute },
});

test("a one-digit hour in a 24-hour clock is a stated time, like its zero-padded form", () => {
  assert.deepEqual(parseStatedClockTimes("9:00"), one(9, 0));
  assert.deepEqual(parseStatedClockTimes("09:00"), one(9, 0));
  assert.deepEqual(parseStatedClockTimes("8:30"), one(8, 30));
  assert.deepEqual(parseStatedClockTimes("0:30"), one(0, 30));
});

test("a two-time phrase with a one-digit first hour states two times, not just one half", () => {
  assert.deepEqual(parseStatedClockTimes("9:00 to 17:00"), { kind: "several" });
  assert.deepEqual(parseStatedClockTimes("9:00-17:00"), { kind: "several" });
  assert.deepEqual(parseStatedClockTimes("10:00 to 9:00"), { kind: "several" });
  assert.deepEqual(parseStatedClockTimes("8:00 to 9:00"), { kind: "several" });
});

test("a seconds form reads its clock, not the inner minutes and seconds", () => {
  assert.deepEqual(parseStatedClockTimes("9:00:30"), one(9, 0));
  assert.deepEqual(parseStatedClockTimes("17:00:30"), one(17, 0));
});

test("controls that must not change", () => {
  assert.deepEqual(parseStatedClockTimes("17:00"), one(17, 0));
  assert.deepEqual(parseStatedClockTimes("19:15"), one(19, 15));
  assert.deepEqual(parseStatedClockTimes("9:00pm"), one(21, 0));
  assert.deepEqual(parseStatedClockTimes("25:00"), { kind: "none" });
  assert.deepEqual(parseStatedClockTimes("29:00"), { kind: "none" });
  assert.deepEqual(parseStatedClockTimes("12:00 to 13:00"), { kind: "several" });
});
