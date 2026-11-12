/** Require each real browser storage/coordinator scenario without skipped cases. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const output = testOutputPath("quint-files-review");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const result = spawnSync(
  process.execPath,
  [
    "packages/scripts/run-with-deadline.ts",
    "120000",
    "--",
    "bun",
    "run",
    "--cwd",
    "plugins/plugin-assistant",
    "test:files-review",
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
const log = path.join(directory, "browser.tap");
writeFileSync(log, `${result.stdout ?? ""}${result.stderr ?? ""}`);
if (result.error) throw result.error;
assert.equal(result.signal, null, `Browser conformance terminated: ${log}`);
assert.equal(result.status, 0, `Browser conformance failed: ${log}`);
const required = [
  "refresh keeps the first reviewed file identity after path replacement",
  "an older empty listing cannot erase the newer review's file identity",
  "an older identity read cannot replace a newer review context",
  "a cancelled identity read never pins files the owner did not review",
];
for (const name of required) {
  assert(
    result.stdout
      .split("\n")
      .some((line) => /^ok \d+ - /.test(line) && line.endsWith(name)),
    `Missing browser case ${name}`,
  );
}
assert.match(result.stdout, /^# tests 4$/m);
assert.match(result.stdout, /^# pass 4$/m);
assert.match(result.stdout, /^# fail 0$/m);
assert.match(result.stdout, /^# skipped 0$/m);
console.log(
  `Four Chromium/IndexedDB Files review scenarios passed. Receipt ${log}`,
);
