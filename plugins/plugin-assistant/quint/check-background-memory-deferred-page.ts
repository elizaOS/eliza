/** Bind the deferred-page model to the background memory regression. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../../packages/scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const packageRoot = path.join(root, "plugins/plugin-assistant");
const model = "plugins/plugin-assistant/quint/BackgroundMemoryDeferredPage.qnt";
const testFile =
  "plugins/plugin-assistant/src/services/evaluator-deferred-page.test.ts";
const requiredTests = [
  "deferred evidence after an output limit continues a deferred evidence page after a persistent output-limit stop",
];
assert.equal(
  path.resolve(root, process.argv[2] ?? model),
  path.join(root, model),
);
const output = testOutputPath("quint-background-memory-deferred-page");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const child = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "180000",
    "--",
    process.execPath,
    path.join(root, "packages/scripts/run-vitest.ts"),
    "run",
    "src/services/evaluator-deferred-page.test.ts",
    "-t",
    "continues a deferred evidence page after a persistent output-limit stop",
    "--cache=false",
    "--maxWorkers=1",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    cwd: packageRoot,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  },
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(
  child.signal,
  null,
  `Conformance terminated by ${child.signal}. See ${log}`,
);
assert.equal(child.status, 0, `Conformance failed. See ${log}`);
const tests = requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(root, testFile),
  requiredTests,
);
const inputs = Object.fromEntries(
  [model, model.replace(/\.qnt$/, ".cases.json"), testFile].map((file) => [
    file,
    createHash("sha256")
      .update(readFileSync(path.join(root, file)))
      .digest("hex"),
  ]),
);
writeFileSync(
  path.join(directory, "evidence.json"),
  `${JSON.stringify({ model, inputs, tests, report }, null, 2)}\n`,
);
console.log(
  `Conformance passed ${tests.length} required cases. Evidence ${directory}`,
);
