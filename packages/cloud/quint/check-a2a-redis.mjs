/** Runs named A2A mutations through the production store and real Redis. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SaxesParser } from "saxes";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(root, "packages/cloud/quint/RedisTaskLease.qnt"),
);
// biome-ignore lint/suspicious/noUndeclaredEnvVars: this required conformance endpoint is a private loopback Redis instance.
const endpoint = process.env.A2A_REDIS_TEST_URL;
assert(endpoint, "A2A Redis conformance requires A2A_REDIS_TEST_URL");
const url = new URL(endpoint);
assert(["redis:", "rediss:"].includes(url.protocol));
assert(
  ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
  "A2A Redis conformance requires a private loopback instance",
);
const output = testOutputPath("quint-a2a-redis");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const file =
  "packages/cloud/shared/src/lib/services/__tests__/a2a-task-store.redis.integration.test.ts";
const expected = [
  "an expired append cannot overwrite an acknowledged successor",
  "an expired set cannot replace a newer task",
  "release cannot delete a replacement lease",
  "an expired delete cannot remove a recreated task",
  "overlapping appends retain ordered duplicate and Unicode content",
  "foreign update and delete cannot change the task",
  "index failure reports the uncertain write and preserves full task data",
  "explicit memory backend applies the same atomic token comparisons",
  "delete index failure reports uncertainty and retains a stale member",
  "an old organization index cannot disclose a replacement owner",
  "a supplied task ID cannot replace another organization's live task",
].sort();
const report = path.join(directory, "junit.xml");
const child = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "90000",
    "--",
    "bun",
    "test",
    "--conditions=eliza-source",
    file,
    "--timeout",
    "30000",
    "--reporter=junit",
    `--reporter-outfile=${report}`,
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
await writeFile(
  path.join(directory, "output.log"),
  `${child.stdout ?? ""}\n${child.stderr ?? ""}`,
);
if (child.error) throw child.error;
if (child.signal) process.kill(process.pid, child.signal);
assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
const xml = await readFile(report, "utf8");
const summary = parseJunitSummary(xml);
assert.equal(summary.failures + summary.errors + summary.skipped, 0);
const names = [];
const parser = new SaxesParser({ xmlns: false });
parser.on("opentag", (tag) => {
  if (tag.name !== "testcase") return;
  assert.equal(tag.attributes.file, file);
  assert.equal(tag.attributes.classname, "A2A real Redis lease ownership");
  assert.equal(typeof tag.attributes.name, "string");
  names.push(tag.attributes.name);
});
parser.write(xml).close();
assert.deepEqual(names.sort(), expected);
await writeFile(
  path.join(directory, "summary.json"),
  `${JSON.stringify({ passed: true, summary, checks: names }, null, 2)}\n`,
);
console.log(
  `A2A Redis conformance passed all ${names.length} named implementation checks. Results ${directory}`,
);
