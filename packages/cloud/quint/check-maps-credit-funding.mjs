/** Check the Maps funding model against route and Google boundary scenarios. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SaxesParser } from "saxes";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = testOutputPath("quint-maps-credit-funding");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const required = new Set([
  "credit-funded Maps reserves and settles provider cost without a plan",
  "a credit reservation refusal never dispatches the provider",
  "a cancelled credit-funded request refunds before provider dispatch",
  "client cancellation after billable Google work retains the actual cost",
  "a lost provider response retains unknown settlement instead of refunding",
  "a known first call does not hide an unresolved second provider call",
  "a plan change releases the new reservation and refuses provider dispatch",
  "a duplicate credit-funded request is rejected before another reservation",
  "billable response is observed before a failed response body is buffered",
]);
const names = new Set();
for (const [index, spec] of [
  "packages/cloud/api/__tests__/maps-request-admission.test.ts",
  "packages/cloud/api/__tests__/maps-google-provider.test.ts",
].entries()) {
  const report = path.join(directory, `tests-${index}.xml`);
  const result = spawnSync(
    "bun",
    [
      "--conditions=eliza-source",
      "test",
      spec,
      "--reporter=junit",
      `--reporter-outfile=${report}`,
    ],
    {
      cwd: root,
      env: process.env,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  await writeFile(path.join(directory, `tests-${index}.log`), log);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, log);
  const xml = await readFile(report, "utf8");
  const summary = parseJunitSummary(xml);
  assert.equal(summary.failures + summary.errors + summary.skipped, 0);
  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", (tag) => {
    if (tag.name === "testcase")
      names.add(tag.attributes.name.split(" > ").at(-1));
  });
  parser.write(xml).close();
}
for (const name of required)
  assert.ok(names.has(name), `Missing funding scenario: ${name}`);
await writeFile(
  path.join(directory, "results.json"),
  JSON.stringify(
    {
      status: "passed",
      required: [...required],
      tests: names.size,
    },
    null,
    2,
  ),
);
console.log(`Maps credit conformance passed. Results ${directory}`);
