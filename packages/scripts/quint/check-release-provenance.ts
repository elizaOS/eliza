/** Qualify the exact maintained local npm, Verdaccio and Git integration suites. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SaxesParser } from "saxes";
import { parseJunitSummary } from "../lib/junit-summary.ts";
import { testOutputPath } from "../lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const model = "packages/scripts/quint/ReleasePackedProvenance.qnt";
assert.equal(path.resolve(root, process.argv[2]), path.join(root, model));
const cases = JSON.parse(
  readFileSync(path.join(root, model.replace(".qnt", ".cases.json")), "utf8"),
);
const manifest = JSON.parse(
  readFileSync(
    new URL("./release-provenance-conformance.json", import.meta.url),
    "utf8",
  ),
);
const output = testOutputPath("quint-release-provenance");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const report = path.join(directory, "tests.xml");
const result = spawnSync(
  "bun",
  [
    "test",
    ...manifest.files,
    "--reporter=junit",
    `--reporter-outfile=${report}`,
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      RELEASE_EVIDENCE_DIR: path.join(directory, "registry"),
    },
    encoding: "utf8",
    timeout: 480000,
    maxBuffer: 16 * 1024 * 1024,
  },
);
writeFileSync(
  path.join(directory, "tests.log"),
  `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
);
if (result.error) throw result.error;
assert.equal(result.signal, null);
assert.equal(
  result.status,
  0,
  `Release provenance conformance failed: ${directory}`,
);
const xml = readFileSync(report, "utf8");
const summary = parseJunitSummary(xml);
assert.equal(summary.tests, 20);
assert.equal(summary.executedTests, 20);
assert.equal(summary.failures + summary.errors + summary.skipped, 0);
assert.deepEqual(
  summary.files.map((file) => file.file).sort(),
  [...manifest.files].sort(),
);
const identities: Array<{ file: string; classname: string; name: string }> = [];
const parser = new SaxesParser({ xmlns: false });
parser.on("opentag", (tag) => {
  if (tag.name === "testcase")
    identities.push({
      file: tag.attributes.file,
      classname: tag.attributes.classname ?? "",
      name: tag.attributes.name,
    });
});
parser.write(xml).close();
const keys = (values: typeof identities) =>
  values.map((value) => JSON.stringify(value)).sort();
assert.equal(new Set(keys(identities)).size, 20);
assert.deepEqual(keys(identities), keys(manifest.required));
const sources = Object.fromEntries(
  [
    ...new Set<string>([
      model,
      model.replace(".qnt", ".cases.json"),
      ...cases.sources,
    ]),
  ].map((file) => [
    file,
    createHash("sha256")
      .update(readFileSync(path.join(root, file)))
      .digest("hex"),
  ]),
);
writeFileSync(
  path.join(directory, "evidence.json"),
  `${JSON.stringify({ model, summary, identities, sources, bounds: cases.bounds }, null, 2)}\n`,
);
console.log(
  `Release provenance conformance passed 20 required local cases: ${directory}`,
);
