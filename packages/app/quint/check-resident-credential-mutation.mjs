/** Check the actual Android mutation conductor and app lifecycle binding on the JVM. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(root, "packages/app/quint/ResidentCredentialMutation.qnt"),
);
const output = testOutputPath("quint-resident-credential-mutation");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "jvm-"));
const child = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "120000",
    "--",
    process.execPath,
    "--test",
    "--test-reporter=tap",
    "--test-name-pattern=^actual Android resident credential mutation",
    path.join(root, "packages/auth/android/test/native-sign-in.test.mjs"),
  ],
  { cwd: root, encoding: "utf8" },
);
const log = path.join(directory, "jvm.tap");
writeFileSync(log, `${child.stdout ?? ""}${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(
  child.status,
  0,
  `Android resident credential JVM fixture failed: ${log}`,
);
assert.match(
  child.stdout,
  /^ok \d+ - actual Android resident credential mutation/m,
);
assert.match(child.stdout, /^# pass 1$/m);
assert.match(child.stdout, /^# fail 0$/m);
console.log(
  `Android resident credential mutation conformance passed. JVM receipt ${log}`,
);
