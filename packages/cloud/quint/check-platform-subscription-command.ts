/** Require every named platform command scenario against the migrated PGlite repository. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SaxesParser } from "saxes";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const model = "packages/cloud/quint/PlatformSubscriptionCommand.qnt";
assert(process.argv.length <= 3, "Select only the platform command model");
assert.equal(
  path.resolve(root, process.argv[2] ?? model),
  path.join(root, model),
);
const file =
  "packages/cloud/shared/src/db/repositories/subscription-billing-operations.pglite.test.ts";
const required = [
  "accepts exact command replay and rejects digest or tenant divergence",
  "fences provider dispatch as outcome-unknown and resolves it with revision CAS",
  "platform command dispatch refuses stale or foreign authority and preserves its first fence",
  "platform command failure replay requires the original generation and exact terminal evidence",
  "platform command supersession retires only a prepared intent with exact replay",
  "platform checkout application requires matching retained history and replays only its original result",
  "platform cancel and resume require their dedicated dispatch protocol",
  "platform command original provider identity is protected by the database",
];
const output = testOutputPath("quint-platform-subscription-command");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const report = path.join(directory, "repository.xml");
const pattern = required
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");
const child = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "240000",
    "--",
    "bun",
    "test",
    "--isolate",
    "--conditions=eliza-source",
    path.join(root, file),
    "--test-name-pattern",
    pattern,
    "--reporter=junit",
    `--reporter-outfile=${report}`,
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
await writeFile(
  path.join(directory, "repository.log"),
  `${child.stdout ?? ""}${child.stderr ?? ""}`,
);
if (child.error) throw child.error;
assert.equal(
  child.signal,
  null,
  "Platform command conformance was interrupted",
);
assert.equal(
  child.status,
  0,
  `Platform command repository checks failed. See ${directory}`,
);
const xml = await readFile(report, "utf8");
const summary = parseJunitSummary(xml);
assert.equal(summary.executedTests, required.length);
assert.equal(summary.failures + summary.errors, 0);
assert.equal(summary.files.length, 1);
const names: string[] = [];
const excluded: string[] = [];
let current: { name: string; skipped: boolean } | undefined;
const parser = new SaxesParser({ xmlns: false });
parser.on("opentag", (tag) => {
  if (tag.name === "testcase") {
    assert.equal(
      typeof tag.attributes.name,
      "string",
      "A testcase needs its name",
    );
    current = {
      name: String(tag.attributes.name).split(" > ").at(-1) ?? "",
      skipped: false,
    };
  } else if (tag.name === "skipped" && current) current.skipped = true;
});
parser.on("closetag", (tag) => {
  if (tag.name !== "testcase") return;
  assert(current, "A testcase must have an opening tag");
  (current.skipped ? excluded : names).push(current.name);
  current = undefined;
});
parser.write(xml).close();
// Bun includes unrelated, pattern-excluded tests in JUnit. Every selected
// contract scenario must execute; a skipped required case never counts as proof.
assert.equal(summary.tests, names.length + excluded.length);
assert.equal(summary.skipped, excluded.length);
assert(
  excluded.every((name) => !required.includes(name)),
  "A required command scenario was skipped",
);
assert.deepEqual(
  names.sort(),
  [...required].sort(),
  "Every required command scenario must execute",
);
await writeFile(
  path.join(directory, "results.json"),
  `${JSON.stringify({ status: "passed", model, file, names, excluded, summary, report }, null, 2)}\n`,
);
console.log(
  `Platform command conformance passed ${required.length} scenarios. Results ${directory}`,
);
