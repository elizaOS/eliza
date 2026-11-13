/** Reuse the owning production-controller JVM lifecycle, including handoff races. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
assert.equal(path.resolve(root, process.argv[2] ?? ""), path.join(root,
  "plugins/plugin-local-inference/quint/MicrophoneHandoff.qnt"));
const output = testOutputPath("quint-microphone-handoff");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "jvm-"));
const child = spawnSync(process.execPath, ["--test", "--test-reporter=tap",
  "--test-name-pattern=^live capture controller orders|^the product-subclassable speech bridge compiles",
  path.join(root, "packages/app/scripts/paradee-voice/speech-pipeline-contract.test.mjs")],
  { cwd: root, encoding: "utf8", timeout: 180000 });
const log = path.join(directory, "jvm.tap");
writeFileSync(log, `${child.stdout ?? ""}${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(child.status, 0, `Native microphone handoff failed: ${log}`);
assert.match(child.stdout, /^ok \d+ - live capture controller orders/m);
assert.match(child.stdout, /^ok \d+ - the product-subclassable speech bridge compiles/m);
assert.match(child.stdout, /^# pass 2$/m);
assert.match(child.stdout, /^# fail 0$/m);
assert.match(child.stdout, /^# skipped 0$/m);
assert.match(child.stdout, /^# todo 0$/m);
console.log(`Native microphone handoff conformance passed: ${log}`);
