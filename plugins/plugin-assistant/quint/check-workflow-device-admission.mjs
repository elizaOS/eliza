/** Run complete named implementation suites for workflow/device admission models. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SaxesParser } from "saxes";
import { parseJunitSummary } from "../../../packages/scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../../packages/scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const models = JSON.parse(
  readFileSync(
    new URL("./workflow-device-admission-conformance.json", import.meta.url),
    "utf8",
  ),
);
const requested = path.resolve(root, process.argv[2] ?? "");
const model = Object.keys(models).find(
  (file) => path.join(root, file) === requested,
);
assert(model, "Unknown workflow/device admission model");
const casesFile = model.replace(/\.qnt$/, ".cases.json");
const cases = JSON.parse(readFileSync(path.join(root, casesFile), "utf8"));
const output = testOutputPath(
  `quint-${path.basename(model, ".qnt").toLowerCase()}`,
);
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const outcomes = [];
for (const [index, suite] of models[model].entries()) {
  const report = path.join(
    directory,
    `${index}.${suite.kind === "vitest" ? "json" : "xml"}`,
  );
  const cwd = path.join(root, suite.cwd ?? ".");
  const file = path.relative(cwd, path.join(root, suite.file));
  const command =
    suite.kind === "vitest"
      ? [
          process.execPath,
          path.join(root, "packages/scripts/run-vitest.ts"),
          "run",
          "--config",
          suite.config,
          file,
          "--cache=false",
          "--maxWorkers=1",
          "--reporter=json",
          `--outputFile=${report}`,
        ]
      : suite.kind === "bun"
        ? [
            "bun",
            "--conditions=eliza-source",
            "test",
            `./${file}`,
            "--timeout=120000",
            "--reporter=junit",
            `--reporter-outfile=${report}`,
          ]
        : [
            process.execPath,
            "--experimental-transform-types",
            "--conditions=eliza-source",
            "--test",
            "--test-reporter=junit",
            file,
          ];
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "packages/scripts/run-with-deadline.ts"),
      "240000",
      "--",
      ...command,
    ],
    { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  writeFileSync(
    path.join(directory, `${index}.log`),
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `Interrupted implementation: ${directory}`);
  assert.equal(result.status, 0, `Failed implementation: ${directory}`);
  if (suite.kind === "node") writeFileSync(report, result.stdout);
  if (suite.kind === "vitest") {
    outcomes.push({
      file: suite.file,
      identities: requireVitestConformance(
        JSON.parse(readFileSync(report, "utf8")),
        path.join(root, suite.file),
        suite.required,
      ),
    });
  } else {
    const xml = readFileSync(report, "utf8");
    let junit = xml;
    if (suite.kind === "node") {
      // Node 24 emits flat testcases and summary comments. Require its full
      // successful summary before adding the suite the shared parser expects.
      const fields = [
        ...xml.matchAll(
          /<!-- (tests|suites|pass|fail|cancelled|skipped|todo) (\d+) -->/g,
        ),
      ];
      assert.equal(fields.length, 7);
      const counts = Object.fromEntries(
        fields.map((field) => [field[1], Number(field[2])]),
      );
      assert.equal(Object.keys(counts).length, 7);
      assert.equal(counts.tests, suite.required.length);
      assert.equal(counts.pass, counts.tests);
      for (const field of ["suites", "fail", "cancelled", "skipped", "todo"])
        assert.equal(counts[field], 0, `Node conformance has ${field}`);
      assert.equal(xml.split("<testsuites>").length, 2);
      assert.equal(xml.split("</testsuites>").length, 2);
      junit = xml
        .replace(
          "<testsuites>",
          `<testsuites tests="${counts.tests}" failures="0" errors="0" skipped="0"><testsuite name="node-contracts" tests="${counts.tests}" failures="0" errors="0" skipped="0">`,
        )
        .replace("</testsuites>", "</testsuite></testsuites>");
    }
    const summary = parseJunitSummary(junit);
    assert.equal(summary.tests, suite.required.length);
    assert.equal(summary.executedTests, suite.required.length);
    assert.equal(summary.failures + summary.errors + summary.skipped, 0);
    const names = [];
    const parser = new SaxesParser({ xmlns: false });
    parser.on("opentag", (tag) => {
      if (tag.name === "testcase") {
        assert.equal(typeof tag.attributes.name, "string");
        if (suite.kind === "node")
          assert.equal(tag.attributes.file, path.join(root, suite.file));
        names.push(tag.attributes.name);
      }
    });
    parser.write(xml).close();
    assert.equal(new Set(names).size, names.length);
    assert.deepEqual(names.sort(), [...suite.required].sort());
    outcomes.push({ file: suite.file, identities: names, summary });
  }
}
const sources = Object.fromEntries(
  [...new Set([model, casesFile, ...cases.sources])].sort().map((file) => [
    file,
    createHash("sha256")
      .update(readFileSync(path.join(root, file)))
      .digest("hex"),
  ]),
);
writeFileSync(
  path.join(directory, "evidence.json"),
  `${JSON.stringify({ model, sources, outcomes, bounds: cases.bounds }, null, 2)}\n`,
);
console.log(
  `Workflow/device conformance passed ${outcomes.reduce((count, item) => count + item.identities.length, 0)} named cases: ${directory}`,
);
