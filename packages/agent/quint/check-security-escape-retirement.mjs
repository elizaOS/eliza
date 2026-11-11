/** Requires real runtime/SQLite and HTTP behavior in separate Vitest processes. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const model = "packages/agent/quint/SecurityEscapeRetirement.qnt";
assert.equal(path.resolve(root, process.argv[2] ?? ""), path.join(root, model));
const casesFile = model.replace(".qnt", ".cases.json");
const cases = JSON.parse(readFileSync(path.join(root, casesFile), "utf8"));
const manifest = JSON.parse(
  readFileSync(
    path.join(
      root,
      "packages/agent/quint/security-escape-retirement-conformance.json",
    ),
    "utf8",
  ),
);
const sourceFiles = [...new Set([model, casesFile, ...cases.sources])];
function sourceHashes() {
  return Object.fromEntries(
    sourceFiles.map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(path.join(root, file)))
        .digest("hex"),
    ]),
  );
}
const before = sourceHashes();
const output = testOutputPath("quint-security-escape-retirement");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const identities = [];
assert.equal(manifest.suites.length, 2);
assert.equal(new Set(manifest.suites.map((suite) => suite.file)).size, 2);
for (const [index, suite] of manifest.suites.entries()) {
  const report = path.join(directory, `suite-${index}.json`);
  const cwd = path.join(root, suite.package);
  const child = spawnSync(
    process.execPath,
    [
      path.join(root, "packages/scripts/run-with-deadline.ts"),
      "240000",
      "--",
      process.execPath,
      "--conditions=eliza-source",
      path.join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      "vitest.config.ts",
      path.relative(cwd, path.join(root, suite.file)),
      "--maxWorkers=1",
      "--cache=false",
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    { cwd, env: process.env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  writeFileSync(
    path.join(directory, `suite-${index}.log`),
    `${child.stdout ?? ""}\n${child.stderr ?? ""}`,
  );
  if (child.error) throw child.error;
  assert.equal(child.signal, null, "Security policy conformance interrupted");
  assert.equal(
    child.status,
    0,
    `Security policy conformance failed; see ${directory}`,
  );
  identities.push({
    file: suite.file,
    tests: requireVitestConformance(
      JSON.parse(readFileSync(report, "utf8")),
      path.join(root, suite.file),
      suite.requiredNames,
    ),
  });
}
assert.equal(
  identities.reduce((count, suite) => count + suite.tests.length, 0),
  22,
);
assert.deepEqual(
  sourceHashes(),
  before,
  "Conformance inputs changed during execution",
);
writeFileSync(
  path.join(directory, "evidence.json"),
  `${JSON.stringify(
    {
      model,
      node: process.version,
      identities,
      sources: before,
      bounds: cases.bounds,
    },
    null,
    2,
  )}\n`,
);
console.log(
  `Security escape retirement conformance passed 22 real runtime/SQLite/HTTP cases: ${directory}`,
);
