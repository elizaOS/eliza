import assert from "node:assert/strict";
import test from "node:test";
import { resolveDesktopBuildConcurrency } from "./desktop-preflight.mjs";

test("desktop package concurrency preserves its default and accepts bounded overrides", () => {
  assert.equal(resolveDesktopBuildConcurrency(undefined), 8);
  for (const value of ["1", "2", "8", "32"]) {
    assert.equal(resolveDesktopBuildConcurrency(value), Number(value));
  }
});

test("desktop package concurrency rejects invalid values before starting work", () => {
  for (const value of [
    "",
    "0",
    "-1",
    "1.5",
    "2x",
    " 2",
    "2 ",
    "33",
    "Infinity",
    "99999999999999999999",
  ]) {
    assert.throws(
      () => resolveDesktopBuildConcurrency(value),
      /integer from 1 to 32/,
    );
  }
});
