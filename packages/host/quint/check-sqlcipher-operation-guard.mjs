/** Run the maintained SQLCipher adapter fixture with actual SQLite effects. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const model = path.join(
  root,
  "packages/host/quint/SqlCipherOperationGuard.qnt",
);
assert.equal(process.argv.length, 3);
assert.equal(path.resolve(root, process.argv[2]), model);
const required = [
  "encrypted driver requires explicit absolute artifact, exact hash and independent ABI",
  "failed native loads close descriptors and remove private snapshots",
  "installed artifacts reject a different unprivileged owner before native loading",
  "Android-installed libraries admit only an installer-owned file the app cannot rewrite",
  "provider reads every row through the guarded native queryAll",
];
const producer = testOutputPath("quint-sqlcipher-operation-guard");
mkdirSync(producer, { recursive: true });
const report = path.join(
  mkdtempSync(path.join(producer, "run-")),
  "adapter-tests.tap",
);
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "30000",
    "--",
    process.execPath,
    "--test",
    "--test-reporter=tap",
    "packages/host/native-host/task-sqlcipher.test.mjs",
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 },
);
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
writeFileSync(report, output);
if (result.error) throw result.error;
assert.equal(
  result.status,
  0,
  `SQLCipher adapter checks failed. Report ${report}`,
);
const names = [...output.matchAll(/^ok \d+ - (.+)$/gm)].map(
  (match) => match[1],
);
assert.deepEqual(
  names.sort(),
  required.sort(),
  `SQLCipher adapter tests changed. Report ${report}`,
);
const counts = new Set(output.split(/\r?\n/));
for (const line of [
  `# tests ${required.length}`,
  `# pass ${required.length}`,
  "# fail 0",
  "# skipped 0",
  "# cancelled 0",
]) {
  assert(
    counts.has(line),
    `Incomplete SQLCipher adapter test run. Report ${report}`,
  );
}
console.log(
  `SQLCipher adapter conformance passed ${required.length} checks. Report ${report}`,
);
