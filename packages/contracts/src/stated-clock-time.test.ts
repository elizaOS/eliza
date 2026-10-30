import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStatedClockTimes } from "./stated-clock-time.ts";

const range = (start: [number, number], end: [number, number]) => ({
  kind: "one",
  start: { hour: start[0], minute: start[1] },
  end: { hour: end[0], minute: end[1] },
});

test("a bare range start borrows the end meridiem when it stays before the end", () => {
  assert.deepEqual(
    parseStatedClockTimes("10 to 11pm"),
    range([22, 0], [23, 0]),
  );
  assert.deepEqual(parseStatedClockTimes("12 to 1pm"), range([12, 0], [13, 0]));
  assert.deepEqual(parseStatedClockTimes("9am to 5pm"), range([9, 0], [17, 0]));
});

test("a bare range start that would pass the end takes the other meridiem", () => {
  assert.deepEqual(
    parseStatedClockTimes("from 9 to 5pm"),
    range([9, 0], [17, 0]),
  );
  assert.deepEqual(parseStatedClockTimes("11-1pm"), range([11, 0], [13, 0]));
  assert.deepEqual(
    parseStatedClockTimes("9:30 until 9pm"),
    range([9, 30], [21, 0]),
  );
  assert.deepEqual(parseStatedClockTimes("11 to 12am"), range([23, 0], [0, 0]));
  assert.deepEqual(parseStatedClockTimes("9 to 9pm"), range([9, 0], [21, 0]));
});

test("an explicit start meridiem is never changed", () => {
  assert.deepEqual(parseStatedClockTimes("9pm to 5am"), range([21, 0], [5, 0]));
});
