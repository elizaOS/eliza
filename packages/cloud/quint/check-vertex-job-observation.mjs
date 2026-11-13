/** Require actual SQL/API refresh, storage-generation and tenant-isolation scenarios. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SaxesParser } from "saxes";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const model = "packages/cloud/quint/VertexJobObservation.qnt";
assert.equal(
  path.resolve(root, process.argv[2] ?? model),
  path.join(root, model),
);
const suites = [
  {
    file: "packages/cloud/api/__tests__/vertex-job-refresh.pglite.test.ts",
    required: [
      "job-name GET uses one provider observation for its response and stored receipt",
      "a delayed running observation cannot overwrite a newer successful job",
      "a job deleted during the provider read returns absence without publishing a model",
      "canonical nested tunedModel fields publish the original resource and retain unknown payload fields",
      "nanosecond observations are ordered without Date rounding and timezone equivalents conflict exactly",
      "same-terminal updates retain original completion and model ownership while refreshing full metadata",
      "invalid provider identity, timestamp and unknown state leave the stored job untouched",
      "cancelling observations cannot return to running but can reach terminal failure",
      "partial success permits definitive success and a delayed older partial cannot regress it",
      "immutable payload generations survive SQL rollback and exact replay verifies the retained object",
      "offloaded list reads return complete payloads and reject missing or malformed retained objects",
      "model identity collision cannot transfer another owner's model or partially commit success",
      "a job deleted while its stored object is loading returns absence before provider work",
      "submitted job replay preserves original ownership and rejects replacement intent",
      "canonical job names retain configured project provenance during refresh",
      "provider-associated numeric resources bind once to the exact ID-form job",
      "submitted canonical names preserve immutable request project provenance",
      "creation retains the provider-assigned name from the configured project request",
      "provider state JOB_STATE_UNSPECIFIED is retained without collapsing its meaning",
      "provider state JOB_STATE_QUEUED is retained without collapsing its meaning",
      "provider state JOB_STATE_PENDING is retained without collapsing its meaning",
      "provider state JOB_STATE_RUNNING is retained without collapsing its meaning",
      "provider state JOB_STATE_SUCCEEDED is retained without collapsing its meaning",
      "provider state JOB_STATE_FAILED is retained without collapsing its meaning",
      "provider state JOB_STATE_CANCELLING is retained without collapsing its meaning",
      "provider state JOB_STATE_CANCELLED is retained without collapsing its meaning",
      "provider state JOB_STATE_PAUSED is retained without collapsing its meaning",
      "provider state JOB_STATE_EXPIRED is retained without collapsing its meaning",
      "provider state JOB_STATE_UPDATING is retained without collapsing its meaning",
      "provider state JOB_STATE_PARTIALLY_SUCCEEDED is retained without collapsing its meaning",
    ],
  },
  {
    file: "packages/cloud/shared/src/lib/services/__tests__/vertex-model-registry-scope.test.ts",
    required: [
      "pglite applied (loud)",
      "syncJobStatus: org A viewer canNOT read org B's job by id (null, no write)",
      "syncJobStatus: org A viewer canNOT read org B's job by name (null)",
      "job visibility predicate admits the owner (org B) and denies org A",
      "activateAssignment: org A canNOT activate org B's private model",
      "activateAssignment: org A CAN activate its own model",
      "activateAssignment: org A CAN activate a global model",
    ],
  },
  {
    file: "packages/cloud/shared/src/db/migrations/vertex-observation-authority.test.ts",
    required: [
      "0562 preserves legacy unknown precision and adds complete Vertex state authority",
    ],
  },
];
const output = testOutputPath("quint-vertex-job-observation");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const results = [];
for (const [index, suite] of suites.entries()) {
  const report = path.join(directory, `${index}.xml`);
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "packages/scripts/run-with-deadline.ts"),
      "180000",
      "--",
      "bun",
      "test",
      "--isolate",
      "--conditions=eliza-source",
      suite.file,
      "--reporter=junit",
      `--reporter-outfile=${report}`,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  await writeFile(
    path.join(directory, `${index}.log`),
    `${result.stdout ?? ""}${result.stderr ?? ""}`,
  );
  if (result.error) throw result.error;
  assert.equal(result.signal, null, "Vertex conformance was interrupted");
  assert.equal(
    result.status,
    0,
    `Vertex implementation checks failed: ${directory}`,
  );
  const xml = await readFile(report, "utf8");
  const summary = parseJunitSummary(xml);
  assert.equal(summary.tests, suite.required.length);
  assert.equal(summary.executedTests, suite.required.length);
  assert.equal(summary.errors + summary.failures + summary.skipped, 0);
  const names = [];
  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", (tag) => {
    if (tag.name === "testcase")
      names.push(String(tag.attributes.name).split(" > ").at(-1));
  });
  parser.write(xml).close();
  assert.deepEqual(
    names.sort(),
    [...suite.required].sort(),
    "Every required Vertex scenario must execute",
  );
  results.push({ file: suite.file, names, summary, report });
}
await writeFile(
  path.join(directory, "results.json"),
  `${JSON.stringify({ status: "passed", results }, null, 2)}\n`,
);
console.log(
  `Vertex observation conformance passed ${suites.reduce((sum, suite) => sum + suite.required.length, 0)} scenarios. Results ${directory}`,
);
