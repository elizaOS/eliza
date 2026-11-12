/** Require the complete journal/controller suites and exact effect-boundary cases. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../../packages/scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const plugin = path.join(root, "plugins/plugin-inbox");
const required = JSON.parse(
  readFileSync(
    new URL("./inbox-receipt-conformance.json", import.meta.url),
    "utf8",
  ),
);
const parent = testOutputPath("quint-inbox-receipt");
mkdirSync(parent, { recursive: true });
const output = mkdtempSync(path.join(parent, "run-"));
const outcomes = [];
for (const [index, [file, names]] of Object.entries(required).entries()) {
  const report = path.join(output, `${index}.json`);
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "packages/scripts/run-with-deadline.ts"),
      "300000",
      "--",
      process.execPath,
      path.join(root, "packages/scripts/run-vitest.ts"),
      "run",
      "--config",
      "./vitest.config.ts",
      `./${file}`,
      "--cache=false",
      "--maxWorkers=1",
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    { cwd: plugin, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  writeFileSync(
    path.join(output, `${index}.log`),
    `${result.stdout}\n${result.stderr}`,
  );
  if (result.error) throw result.error;
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const cases = requireVitestConformance(
    JSON.parse(readFileSync(report, "utf8")),
    path.join(plugin, file),
    names,
  );
  outcomes.push({ file, cases });
}
assert.equal(
  outcomes.reduce((n, row) => n + row.cases.length, 0),
  26,
);
writeFileSync(
  path.join(output, "conformance.json"),
  JSON.stringify(
    { status: "passed", skipped: 0, tests: 26, outcomes },
    null,
    2,
  ),
);
console.log(
  `26 exact Inbox journal/controller cases passed without skips. Results ${output}`,
);
