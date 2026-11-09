/** Run the shared exact Java sign-in and acknowledgement fixture. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const model = path.resolve(root, process.argv[2] ?? "");
assert.equal(path.dirname(model), import.meta.dirname);
assert(
  [
    "NativeAndroidAckRecovery.qnt",
    "NativeAndroidCodeVerification.qnt",
  ].includes(path.basename(model)),
  "Expected an Android sign-in model",
);

const output = testOutputPath("quint-native-android-sign-in");
mkdirSync(output, { recursive: true });
const receipt = mkdtempSync(path.join(output, "jvm-"));
const child = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "180000",
    "--",
    process.execPath,
    "--test",
    "--test-reporter=tap",
    "--test-name-pattern=^exact native verify/connect/token/ack chain",
    path.join(root, "packages/auth/android/test/native-sign-in.test.mjs"),
  ],
  { cwd: root, encoding: "utf8" },
);
const log = path.join(receipt, "jvm.tap");
writeFileSync(log, `${child.stdout ?? ""}${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(child.status, 0, `Android sign-in JVM fixture failed: ${log}`);
assert.match(
  child.stdout,
  /^ok \d+ - exact native verify\/connect\/token\/ack chain/m,
);
assert.match(child.stdout, /^# pass 1$/m);
assert.match(child.stdout, /^# fail 0$/m);
console.log(
  `Android sign-in and acknowledgement scenarios passed. JVM receipt ${log}`,
);
