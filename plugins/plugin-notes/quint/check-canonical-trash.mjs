/** Requires complete named Notes suites, including actual Store and owner HTTP boundaries. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../../packages/scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const model = "plugins/plugin-notes/quint/CanonicalNotesTrash.qnt";
assert.equal(path.resolve(root, process.argv[2] ?? ""), path.join(root, model));
const casesFile = model.replace(".qnt", ".cases.json");
const cases = JSON.parse(readFileSync(path.join(root, casesFile), "utf8"));
const manifest = JSON.parse(
  readFileSync(
    path.join(
      root,
      "plugins/plugin-notes/quint/canonical-trash-conformance.json",
    ),
    "utf8",
  ),
);
const sourceFiles = [...new Set([model, casesFile, ...cases.sources])];
function hashes() {
  return Object.fromEntries(
    sourceFiles.map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(path.join(root, file)))
        .digest("hex"),
    ]),
  );
}
const before = hashes();
const output = testOutputPath("quint-canonical-notes-trash");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
assert.equal(manifest.suites.length, 4);
assert.equal(new Set(manifest.suites.map((suite) => suite.file)).size, 4);
const identities = [];
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
  assert.equal(child.signal, null, "Notes conformance interrupted");
  assert.equal(child.status, 0, `Notes conformance failed; see ${directory}`);
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
  87,
);
assert.deepEqual(hashes(), before, "Notes inputs changed during conformance");
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
  `Canonical Notes Trash conformance passed 87 named cases including real Store and owner HTTP checks: ${directory}`,
);
