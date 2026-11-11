/** Require the production TS ownership and closed-result boundary, without native proof claims. */
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
const plugin = path.join(root, "plugins/plugin-assistant");
const model = "plugins/plugin-assistant/quint/TelephonyActionOwnership.qnt";
assert.equal(
  path.resolve(root, process.argv[2] ?? model),
  path.join(root, model),
);
const cases = model.replace(/\.qnt$/, ".cases.json");
const manifest = JSON.parse(readFileSync(path.join(root, cases), "utf8"));
const suites = JSON.parse(
  readFileSync(
    new URL("./telephony-action-conformance.json", import.meta.url),
    "utf8",
  ),
);
const output = testOutputPath("quint-telephony-action-ownership");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
function run(name: string, cwd: string, args: string[]) {
  const log = path.join(directory, `${name}.log`);
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "packages/scripts/run-with-deadline.ts"),
      "180000",
      "--",
      ...args,
    ],
    { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  writeFileSync(log, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `Conformance terminated: ${log}`);
  assert.equal(result.status, 0, `Conformance failed: ${log}`);
}

const coordinatorReport = path.join(directory, "coordinator.json");
run("coordinator", plugin, [
  process.execPath,
  path.join(root, "packages/scripts/run-vitest.ts"),
  "run",
  path.relative(plugin, path.join(root, suites.coordinator.file)),
  "--cache=false",
  "--maxWorkers=1",
  "--reporter=json",
  `--outputFile=${coordinatorReport}`,
]);
const coordinator = requireVitestConformance(
  JSON.parse(readFileSync(coordinatorReport, "utf8")),
  path.join(root, suites.coordinator.file),
  suites.coordinator.required,
);

const contractReport = path.join(directory, "contracts.xml");
run("contracts", root, [
  "bun",
  "test",
  "--conditions=eliza-source",
  suites.contracts.file,
  "--reporter=junit",
  `--reporter-outfile=${contractReport}`,
]);
const xml = readFileSync(contractReport, "utf8");
const summary = parseJunitSummary(xml);
assert.equal(summary.tests, suites.contracts.required.length);
assert.equal(summary.failures + summary.errors + summary.skipped, 0);
assert.equal(summary.files.length, 1, "Expected exactly one contract file");
assert.equal(
  path.resolve(root, summary.files[0].file ?? ""),
  path.join(root, suites.contracts.file),
);
const names: string[] = [];
const parser = new SaxesParser({ xmlns: false });
parser.on("opentag", (tag) => {
  if (tag.name === "testcase") {
    assert.equal(typeof tag.attributes.name, "string");
    names.push(tag.attributes.name as string);
  }
});
parser.write(xml).close();
assert.equal(new Set(names).size, names.length, "Duplicate contract test");
assert.deepEqual(names.sort(), [...suites.contracts.required].sort());
const sources = Object.fromEntries(
  [...new Set<string>([model, cases, ...manifest.sources])]
    .sort()
    .map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(path.join(root, file)))
        .digest("hex"),
    ]),
);
writeFileSync(
  path.join(directory, "evidence.json"),
  `${JSON.stringify(
    {
      model,
      status: "passed",
      sources,
      coordinator,
      contracts: { names, summary },
      boundary:
        "Controlled TS ports and real validators; no Gradle, device, carrier or VVM proof.",
    },
    null,
    2,
  )}\n`,
);
console.log(
  `Telephony TS conformance passed ${coordinator.length + names.length} required cases. Evidence ${directory}`,
);
