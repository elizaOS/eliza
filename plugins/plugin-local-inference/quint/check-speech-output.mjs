/** Check the real Java warm-up with controlled output ports and bridge wiring. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const plugin = "plugins/plugin-local-inference";
assert.equal(
  path.resolve(process.argv[2] ?? ""),
  path.join(root, plugin, "quint/SpeechOutputWarmup.qnt"),
);
const output = testOutputPath("quint-speech-output");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const required = [
  "the speech output warm-up is bounded, and close stops it at once, also a blocked write or a late open",
  "the bridge starts the warm-up only for a foreground idle speaker outside protected surfaces and closes it on every stop path",
];
const run = spawnSync(
  process.execPath,
  [
    "--test",
    "--test-reporter=tap",
    ...required.flatMap((name) => ["--test-name-pattern", `^${name}$`]),
    `${plugin}/native/android/test/speech-output.node.mjs`,
  ],
  { cwd: root, encoding: "utf8", timeout: 180_000 },
);
const log = `${run.stdout ?? ""}${run.stderr ?? ""}`;
writeFileSync(path.join(directory, "speech-output.tap"), log);
if (run.error) throw run.error;
assert.equal(run.status, 0, log);
assert.deepEqual(
  [...log.matchAll(/^ok \d+ - (.+)$/gm)].map((match) => match[1]).sort(),
  [...required].sort(),
);
assert.match(log, new RegExp(`^# tests ${required.length}$`, "m"));
assert.match(log, new RegExp(`^# pass ${required.length}$`, "m"));
assert.match(log, /^# skipped 0$/m);
console.log(
  `Speech output conformance passed ${required.length} cases. Evidence ${directory}`,
);
