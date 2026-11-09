import assert from "node:assert/strict";
import test from "node:test";
import logic from "./yolo-logic.js";

test("YOLO signal waits for enough valid prices", () => {
  assert.equal(logic.signal([], 0.001), "wait");
  assert.equal(logic.signal([100], 0.001), "wait");
  assert.equal(logic.signal([100, 0], 0.001), "wait");
  assert.equal(logic.signal([100, 101], -0.001), "wait");
});

test("YOLO signal classifies upward, downward, and flat paper moves", () => {
  assert.equal(logic.signal([100, 100.2], 0.001), "momentum-up");
  assert.equal(logic.signal([100, 99.8], 0.001), "momentum-down");
  assert.equal(logic.signal([100, 100.05], 0.001), "flat");
});
