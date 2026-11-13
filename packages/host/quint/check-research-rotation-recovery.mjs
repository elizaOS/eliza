/** Require the native configuration checks with real files and SQLite. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
assert.equal(process.argv.length, 3);
assert.equal(
  path.resolve(root, process.argv[2]),
  path.join(root, "packages/host/quint/ResearchRotationRecovery.qnt"),
);
const required = [
  "private initialization records only a token hash and refuses existing configuration",
  "initialization failure preserves a preexisting config and removes only its new token",
  "configuration refuses public files and symlink indirection",
  "offline rotation preserves encrypted research and audit with closed recovery files",
  "failed database rotation retains both recovery keys and releases its lease",
  "interrupted config publication retains the committed key and stale lease",
];
const output = testOutputPath("quint-host-research-rotation");
mkdirSync(output, { recursive: true });
const report = path.join(
  mkdtempSync(path.join(output, "run-")),
  "rotation.tap",
);
const result = spawnSync(
  "bun",
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "45000",
    "--",
    process.execPath,
    "--test",
    "--test-reporter=tap",
    "packages/host/native-host/research-configuration.test.mjs",
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 },
);
const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
writeFileSync(report, log);
if (result.error) throw result.error;
assert.equal(result.signal, null, `Rotation checks interrupted. ${report}`);
assert.equal(result.status, 0, `Rotation checks failed. ${report}`);
const names = [...log.matchAll(/^ok \d+ - (.+)$/gm)].map((match) => match[1]);
assert.deepEqual(
  names.sort(),
  required.sort(),
  `Rotation tests changed. ${report}`,
);
const counts = new Set(log.split(/\r?\n/));
for (const line of [
  `# tests ${required.length}`,
  `# pass ${required.length}`,
  "# fail 0",
  "# skipped 0",
  "# cancelled 0",
]) {
  assert(counts.has(line), `Incomplete rotation checks. ${report}`);
}
console.log(
  `Research rotation conformance passed ${required.length} configuration cases. ${report}`,
);
