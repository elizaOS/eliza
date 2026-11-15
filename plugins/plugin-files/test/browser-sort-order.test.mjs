import assert from "node:assert/strict";
import test from "node:test";
import { sortEntries } from "../src/browser/storage-model.ts";

const entries = [
  { name: "Folder Z", directory: true, modified: 3, size: 0 },
  { name: "Folder A", directory: true, modified: 4, size: 0 },
  { name: "B", directory: false, modified: 10, size: 30 },
  { name: "a", directory: false, modified: 20, size: 10 },
  { name: "C", directory: false, modified: 30, size: 20 },
];
for (const [mode, forward, reverse] of [
  ["name", ["a", "B", "C"], ["C", "B", "a"]],
  ["date", ["C", "a", "B"], ["B", "a", "C"]],
  ["size", ["B", "C", "a"], ["a", "C", "B"]],
]) {
  for (const [direction, expected] of [
    [false, forward],
    [true, reverse],
  ])
    test(`${mode}: ${direction ? "reverse" : "default"} preserves folders first and input bytes`, () => {
      const before = structuredClone(entries),
        out = sortEntries(entries, mode, direction);
      assert.deepEqual(
        out.slice(2).map((row) => row.name),
        expected,
      );
      assert.deepEqual(
        out.slice(0, 2).map((row) => row.name),
        direction ? ["Folder Z", "Folder A"] : ["Folder A", "Folder Z"],
      );
      assert.deepEqual(entries, before);
    });
}
