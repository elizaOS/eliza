/** Checks the actual PR dependency graph and runs its aggregate shell gate. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { testOutputPath } from "../lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const model = "packages/scripts/quint/CiAdmission.qnt";
assert.equal(path.resolve(root, process.argv[2] ?? ""), path.join(root, model));
const workflowPath = ".github/workflows/pr-validation.yml";
const source = await readFile(path.join(root, workflowPath), "utf8");
const workflow = parse(source);
const required = workflow.jobs.required;
const rules = JSON.parse(
  await readFile(
    path.join(root, ".github/rulesets/required-branches.json"),
    "utf8",
  ),
);
const checks = rules.rules.find(
  (rule) => rule.type === "required_status_checks",
);
assert(
  checks.parameters.required_status_checks.some(
    (check) => check.context === required.name,
  ),
);
const lanes = [
  "secret-scan",
  "source-checks",
  "sdk-owning",
  "billing-payment-replay-e2e",
  "subscription-authority-postgres",
  "paradee-stream-contract",
  "quint",
];
assert.deepEqual(
  [...required.needs].sort(),
  [...lanes].sort(),
  "The aggregate must wait for every mandatory lane, including Quint",
);
assert.equal(
  required.if,
  `\${{ always() && !cancelled() }}`,
  "The aggregate must check every dependency unless the whole workflow is cancelled",
);
const gate = required.steps.find(
  (step) => step.name === "Require every admission lane",
);
assert(gate && typeof gate.run === "string");
const bindings = [
  ...gate.env.RESULTS.matchAll(
    /(\S+)=\$\{\{\s*needs\.([^\s]+)\.result\s*\}\}/g,
  ),
];
assert.deepEqual(bindings.map((match) => match[1]).sort(), [...lanes].sort());
assert(
  bindings.every((match) => match[1] === match[2]),
  "Each result must come from its own dependency",
);
assert.equal(workflow.jobs.quint.name, "Quint state and implementation checks");
const shardJob = workflow.jobs["quint-models"];
const shardGate = workflow.jobs.quint;
assert.deepEqual(shardJob.strategy.matrix.shard, [1, 2, 3, 4]);
assert.equal(shardJob.strategy["fail-fast"], false);
assert.equal(shardJob.outputs.run, `\${{ steps.changes.outputs.run }}`);
assert.equal(
  shardJob.steps.find(
    (step) => step.name === "Verify Quint models and real transitions",
  ).run,
  `bun run test:quint --shard=\${{ matrix.shard }}/4`,
);
assert.equal(
  shardJob.steps.find(
    (step) => step.name === "Upload required Quint shard manifest",
  ).with["if-no-files-found"],
  "error",
);
for (const [job, name] of [
  [shardJob, "Upload Quint evidence"],
  [shardJob, "Upload required Quint shard manifest"],
  [shardGate, "Upload complete Quint evidence summary"],
]) {
  assert.equal(
    job.steps.find((step) => step.name === name).with.overwrite,
    true,
    "A retried job must replace its previous report without losing other shards",
  );
}
assert.deepEqual(shardGate.needs, ["quint-models"]);
assert.equal(
  shardGate.if,
  `\${{ always() && !cancelled() }}`,
  "The Quint aggregate must stop when the whole workflow is cancelled",
);
const shardGuard = shardGate.steps.find(
  (step) => step.name === "Require successful Quint shards",
);
assert.equal(shardGuard.env.RESULT, `\${{ needs.quint-models.result }}`);
assert.equal(
  shardGuard.env.SHOULD_RUN,
  `\${{ needs.quint-models.outputs.run }}`,
);
assert.equal(
  shardGate.steps.find(
    (step) => step.name === "Verify complete disjoint model coverage",
  ).run,
  "bun packages/scripts/check-quint-shards.ts test-results/quint-manifests 4",
);
const output = testOutputPath("quint-ci-admission");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const results = [];
for (const rejectedLane of [undefined, ...lanes]) {
  for (const outcome of rejectedLane
    ? ["failure", "cancelled", "skipped", "running"]
    : ["success"]) {
    const resultValues = bindings
      .map(
        (match) =>
          `${match[1]}=${match[1] === rejectedLane ? outcome : "success"}`,
      )
      .join(" ");
    const result = spawnSync("bash", ["-c", gate.run], {
      cwd: root,
      env: { ...process.env, RESULTS: resultValues },
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.error) throw result.error;
    assert.equal(result.signal, null);
    assert.equal(
      result.status,
      rejectedLane ? 1 : 0,
      `Unexpected aggregate result for ${rejectedLane ?? "all lanes"}: ${outcome}`,
    );
    results.push({
      rejectedLane: rejectedLane ?? null,
      outcome,
      exitCode: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
}
assert.equal(results.length, 29);
const shardResults = [];
for (const result of [
  "success",
  "failure",
  "cancelled",
  "skipped",
  "running",
  "",
]) {
  for (const shouldRun of ["true", "false", ""]) {
    const checked = spawnSync("bash", ["-c", shardGuard.run], {
      cwd: root,
      env: { ...process.env, RESULT: result, SHOULD_RUN: shouldRun },
      encoding: "utf8",
      timeout: 10_000,
    });
    if (checked.error) throw checked.error;
    assert.equal(checked.signal, null);
    const accepted = result === "success" && shouldRun !== "";
    assert.equal(checked.status, accepted ? 0 : 1);
    shardResults.push({ result, shouldRun, accepted });
  }
}
const partitionTests = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "240000",
    "--",
    process.execPath,
    "--test",
    "--test-reporter=tap",
    "packages/scripts/check-quint-shards.node.test.ts",
  ],
  {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    timeout: 250000,
    maxBuffer: 8 * 1024 * 1024,
  },
);
const partitionOutput = `${partitionTests.stdout ?? ""}${partitionTests.stderr ?? ""}`;
await writeFile(path.join(directory, "partitions.tap"), partitionOutput);
if (partitionTests.error) throw partitionTests.error;
assert.equal(
  partitionTests.status,
  0,
  `Partition conformance failed: ${directory}`,
);
assert.equal(partitionTests.signal, null);
for (const [name, count] of Object.entries({
  tests: 7,
  pass: 7,
  fail: 0,
  skipped: 0,
  cancelled: 0,
  todo: 0,
})) {
  assert.match(partitionOutput, new RegExp(`^# ${name} ${count}$`, "m"));
}
assert.equal((partitionOutput.match(/^ok \d+ - /gm) ?? []).length, 7);
assert.match(
  partitionOutput,
  /^ok \d+ - the real runner emits an exhaustive union across four shards$/m,
);
const partitions = { tests: 7, passed: 7, failed: 0, skipped: 0, cancelled: 0 };
await writeFile(
  path.join(directory, "results.json"),
  `${JSON.stringify({ status: "passed", workflowPath, workflowSha256: createHash("sha256").update(source).digest("hex"), results, shardResults, partitions }, null, 2)}\n`,
);
console.log(
  `CI admission conformance passed 29 top-level and 18 shard shell outcomes plus seven partition tests. Results ${directory}`,
);
