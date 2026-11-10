/** Requires the maintained source-level Photos JVM suite without skipped cases. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const output = testOutputPath("quint-native-photos");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const result = spawnSync(
  process.execPath,
  [
    "packages/scripts/run-with-deadline.ts",
    "180000",
    "--",
    process.execPath,
    "--test",
    "--test-reporter=tap",
    "plugins/plugin-native-media/test/native-host/permitted-catalog.node.mjs",
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
const log = path.join(directory, "jvm.tap");
writeFileSync(log, `${result.stdout ?? ""}${result.stderr ?? ""}`);
if (result.error) throw result.error;
assert.equal(result.signal, null, `Photos JVM conformance terminated: ${log}`);
assert.equal(result.status, 0, `Photos JVM conformance failed: ${log}`);
for (const name of [
  "permitted permanent deletion fences restored or changed items and requires exact absence",
  "library reads publish only under the read ticket they were admitted with",
  "an approved write request is applied only after the activity resumes",
  "Photos worker and main publication retain the exact admitted read ticket",
  "Photos native review retains captured selections through resume and replacement",
]) {
  assert(
    result.stdout
      .split("\n")
      .some((line) => /^ok \d+ - /.test(line) && line.endsWith(name)),
    `Missing named Photos JVM case ${name}: ${log}`,
  );
}
assert.match(result.stdout, /^# tests 5$/m);
assert.match(result.stdout, /^# pass 5$/m);
assert.match(result.stdout, /^# fail 0$/m);
assert.match(result.stdout, /^# skipped 0$/m);
console.log(`Five maintained Photos JVM cases passed. Receipt ${log}`);
