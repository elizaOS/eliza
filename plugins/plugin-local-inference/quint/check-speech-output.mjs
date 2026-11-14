/** Check the real Java warm-up with controlled output ports and bridge wiring. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const plugin = "plugins/plugin-local-inference";
assert.equal(path.resolve(process.argv[2] ?? ""), path.join(root, plugin, "quint/SpeechOutputWarmup.qnt"));
const output = testOutputPath("quint-speech-output");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", `${plugin}/native/android/test/speech-output.node.mjs`], {
  cwd: root, encoding: "utf8", timeout: 180_000,
});
const log = `${run.stdout ?? ""}${run.stderr ?? ""}`;
writeFileSync(path.join(directory, "speech-output.tap"), log);
if (run.error) throw run.error;
assert.equal(run.status, 0, log);
assert.match(log, /^ok \d+ - the speech output warm-up is bounded, and close stops it at once, also a blocked write or a late open$/m);
assert.match(log, /^ok \d+ - the bridge starts the warm-up only for a foreground idle speaker outside protected surfaces and closes it on every stop path$/m);
assert.match(log, /^ok \d+ - synthesized lead-in silence is trimmed with a short pre-roll and later audio passes through$/m);
assert.match(log, /^# fail 0$/m);
assert.match(log, /^# skipped 0$/m);
console.log(`Speech output conformance passed all required scenarios. Evidence ${directory}`);
