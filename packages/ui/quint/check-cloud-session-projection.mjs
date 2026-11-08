/** Check mounted account publication with controlled native session ports. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const ui = path.join(root, "packages/ui");
const file = "src/state/__e2e__/native-cloud-session.test.tsx";
const suite = "native account within the common Cloud state owner";
const scenarios = [
  "uses the host's verified snapshot without probing a second account backend",
  "does not publish a late account read from a replaced native owner",
  "does not mark a verified replacement account unavailable when the previous read rejects",
  "retains account state when native retirement refuses and clears it only after acknowledgement",
  "does not publish an old sign-out acknowledgement across a queued owner replacement",
  "routes sign-in activation through the supplied installed credential owner",
];

assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(ui, "quint/CloudSessionProjection.qnt"),
);
const output = testOutputPath("quint-cloud-session-projection");
mkdirSync(output, { recursive: true });
const report = path.join(mkdtempSync(path.join(output, "run-")), "vitest.json");
const child = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "120000",
    "--",
    process.execPath,
    path.join(root, "packages/scripts/run-vitest.ts"),
    "run",
    "--config",
    "vitest.config.ts",
    "--no-file-parallelism",
    file,
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    cwd: ui,
    env: {
      ...process.env,
      NODE_OPTIONS:
        `${process.env.NODE_OPTIONS ?? ""} --no-experimental-webstorage --disable-warning=ExperimentalWarning`.trim(),
    },
    stdio: "inherit",
  },
);
if (child.error) throw child.error;
assert.equal(child.status, 0, "Mounted Cloud session conformance failed");
const checks = requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(ui, file),
  scenarios.map((scenario) => `${suite} ${scenario}`),
);
console.log(
  `Mounted Cloud session passed ${checks.length} checks. Report ${report}`,
);
