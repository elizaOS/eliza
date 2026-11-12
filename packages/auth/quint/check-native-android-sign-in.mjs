/** Run the shared exact Java sign-in and acknowledgement fixture. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const model = path.resolve(root, process.argv[2] ?? "");
assert.equal(path.dirname(model), import.meta.dirname);
// Each model names the JVM fixture that executes the exact plugin methods it describes.
const chain = "^exact native verify/connect/token/ack chain";
const fixtures = {
  "NativeAndroidAckRecovery.qnt": [chain],
  "NativeAndroidCodeVerification.qnt": [chain],
  "NativeAndroidActivation.qnt": [chain],
  "NativeAndroidKeyRenewal.qnt": [
    chain,
    "^silent renewal confirms the new key before saving it",
  ],
  "NativeAndroidReadiness.qnt": [
    "^exact readiness measurement, cache and single-flight probe",
  ],
  "NativeAndroidReturnAdoption.qnt": [
    chain,
    "^the credential intent fence keeps a durable generation",
  ],
};
const patterns = fixtures[path.basename(model)];
assert(patterns, "Expected an Android sign-in model");

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
    ...patterns.map((pattern) => `--test-name-pattern=${pattern}`),
    path.join(root, "packages/auth/android/test/native-sign-in.test.mjs"),
  ],
  { cwd: root, encoding: "utf8" },
);
const log = path.join(receipt, "jvm.tap");
writeFileSync(log, `${child.stdout ?? ""}${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(child.status, 0, `Android sign-in JVM fixture failed: ${log}`);
for (const pattern of patterns)
  assert.match(
    child.stdout,
    new RegExp(`^ok \\d+ - ${pattern.slice(1).replace(/[/]/g, "\\/")}`, "m"),
  );
assert.match(child.stdout, new RegExp(`^# pass ${patterns.length}$`, "m"));
assert.match(child.stdout, /^# fail 0$/m);
console.log(
  `Android sign-in and acknowledgement scenarios passed. JVM receipt ${log}`,
);
