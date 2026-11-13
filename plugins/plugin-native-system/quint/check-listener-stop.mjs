/** Runs the maintained TypeScript and Java stop-evidence boundary cases. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const producer = testOutputPath("quint-listener-stop");
mkdirSync(producer, { recursive: true });
const report = path.join(mkdtempSync(path.join(producer, "run-")), "sense.tap");
const result = spawnSync(
  process.execPath,
  [
    "packages/scripts/run-with-deadline.ts",
    "240000",
    "--",
    process.execPath,
    "--test",
    "--test-reporter=tap",
    "plugins/plugin-native-system/test/sense.test.mjs",
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
writeFileSync(report, output);
if (result.error) throw result.error;
assert.equal(result.signal, null, `Sense conformance terminated: ${report}`);
assert.equal(result.status, 0, `Sense conformance failed: ${report}`);
for (const name of [
  "native client keeps package, permission, component and reset fences",
  "chat-only stop requires an exact raw acknowledgement",
  "chat-only stop is bounded even when the native bridge never replies",
  "a pause receipt requires its save, compatible state and microphone release",
]) {
  assert(
    output
      .split("\n")
      .some((line) => /^ok \d+ - /.test(line) && line.endsWith(name)),
    `Missing required Sense case ${name}: ${report}`,
  );
}
for (const count of ["fail", "cancelled", "skipped"]) {
  assert.match(output, new RegExp(`^# ${count} 0$`, "m"));
}
console.log(`Sense listener stop conformance passed. Receipt ${report}`);
