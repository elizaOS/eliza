/** Require the exact route, durable-owner, real Workerd and client recovery suites. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SaxesParser } from "saxes";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const model = "packages/cloud/quint/speech_prepared_consent.qnt";
assert.equal(path.resolve(root, process.argv[2] ?? ""), path.join(root, model));
const cases = JSON.parse(
  readFileSync(path.join(root, model.replace(".qnt", ".cases.json")), "utf8"),
);
const manifest = JSON.parse(
  readFileSync(
    new URL("./speech-prepared-consent-conformance.json", import.meta.url),
    "utf8",
  ),
);
const output = testOutputPath("quint-speech-prepared-consent");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const outcomes = [];
function run(name, command, cwd = root) {
  const child = spawnSync(
    process.execPath,
    [
      path.join(root, "packages/scripts/run-with-deadline.ts"),
      "240000",
      "--",
      ...command,
    ],
    {
      cwd,
      env: process.env,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  writeFileSync(
    path.join(directory, `${name}.log`),
    `${child.stdout ?? ""}\n${child.stderr ?? ""}`,
  );
  if (child.error) throw child.error;
  assert.equal(child.signal, null, `${name}: interrupted conformance`);
  assert.equal(
    child.status,
    0,
    `${name}: implementation failed; see ${directory}`,
  );
}
// API mock.module declarations are process-global; use one process per file as
// the owning package does. A preceding test must not supply missing exports.
for (const [index, suite] of manifest.bun.entries()) {
  const report = path.join(directory, `${index}.xml`);
  run(`bun-${index}`, [
    "bun",
    "--conditions=eliza-source",
    "test",
    `./${suite.file}`,
    "--timeout=60000",
    "--reporter=junit",
    `--reporter-outfile=${report}`,
  ]);
  const xml = readFileSync(report, "utf8");
  const summary = parseJunitSummary(xml);
  assert.equal(summary.tests, suite.required.length);
  assert.equal(summary.executedTests, suite.required.length);
  assert.equal(summary.failures + summary.errors + summary.skipped, 0);
  assert.deepEqual(
    summary.files.map(({ file }) => file),
    [suite.file],
  );
  const identities = [];
  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", (tag) => {
    if (tag.name === "testcase")
      identities.push({
        classname: tag.attributes.classname ?? "",
        name: tag.attributes.name,
      });
  });
  parser.write(xml).close();
  const keys = (values) => values.map((value) => JSON.stringify(value)).sort();
  assert.equal(new Set(keys(identities)).size, suite.required.length);
  assert.deepEqual(keys(identities), keys(suite.required));
  outcomes.push({ file: suite.file, summary, identities });
}
const clientReport = path.join(directory, "client.json");
const client = manifest.vitest;
run(
  "client",
  [
    process.execPath,
    "--conditions=eliza-source",
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    "vitest.config.ts",
    path.relative(
      path.join(root, "packages/host"),
      path.join(root, client.file),
    ),
    "--maxWorkers=1",
    "--reporter=json",
    `--outputFile=${clientReport}`,
  ],
  path.join(root, "packages/host"),
);
const clientCases = requireVitestConformance(
  JSON.parse(readFileSync(clientReport, "utf8")),
  path.join(root, client.file),
  client.required,
);
outcomes.push({ file: client.file, identities: clientCases });
const sources = Object.fromEntries(
  [
    ...new Set([model, model.replace(".qnt", ".cases.json"), ...cases.sources]),
  ].map((file) => [
    file,
    createHash("sha256")
      .update(readFileSync(path.join(root, file)))
      .digest("hex"),
  ]),
);
writeFileSync(
  path.join(directory, "evidence.json"),
  `${JSON.stringify({ model, outcomes, sources, bounds: cases.bounds }, null, 2)}\n`,
);
console.log(
  `Prepared consent conformance passed ${manifest.bun.reduce((n, suite) => n + suite.required.length, 0)} Bun/Workerd and ${clientCases.length} actual client cases: ${directory}`,
);
