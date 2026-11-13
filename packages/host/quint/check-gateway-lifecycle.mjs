/** Run the maintained local HTTP and file lifecycle checks. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const model = path.join(root, "packages/host/quint/GatewayLifecycle.qnt");
assert.equal(process.argv.length, 3);
assert.equal(path.resolve(root, process.argv[2]), model);
const required = [
  ...[
    "normal shutdown",
    "reputation",
    "capture",
    "capture-sync",
    "tasks",
    "helper",
  ].map(
    (stage) => `real HTTP host releases every resource once after ${stage}`,
  ),
  ...["tasks", "capture", "reputation", "reputation-start", "server"].map(
    (stage) => `startup rollback closes acquired files after ${stage} failure`,
  ),
  "occupied HTTP port rolls back all resources and preserves EADDRINUSE",
  "external HTTP close triggers cleanup even when its observer throws",
  "managed shutdown joins an external HTTP drain before releasing resources",
];
const producer = testOutputPath("quint-gateway-lifecycle");
mkdirSync(producer, { recursive: true });
const report = path.join(
  mkdtempSync(path.join(producer, "run-")),
  "gateway-tests.tap",
);
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "45000",
    "--",
    process.execPath,
    "--test",
    "--test-reporter=tap",
    "packages/host/native-host/gateway-lifecycle.test.mjs",
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 },
);
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
writeFileSync(report, output);
if (result.error) throw result.error;
assert.equal(
  result.status,
  0,
  `Gateway lifecycle checks failed. Report ${report}`,
);
const names = [...output.matchAll(/^ok \d+ - (.+)$/gm)].map(
  (match) => match[1],
);
assert.deepEqual(
  names.sort(),
  required.sort(),
  `Gateway lifecycle tests changed. Report ${report}`,
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
    `Incomplete gateway lifecycle test run. Report ${report}`,
  );
}
console.log(
  `Gateway lifecycle conformance passed ${required.length} HTTP/file checks. Report ${report}`,
);
