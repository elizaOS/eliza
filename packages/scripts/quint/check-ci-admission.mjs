/** Checks the actual PR dependency graph and runs its aggregate shell gate. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";
import { parseJunitSummary } from "../lib/junit-summary.ts";
import { testOutputPath } from "../lib/test-output.ts";
import { validateWorkflowTriggerPolicy } from "../workflow-trigger-policy.ts";

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
const promotion =
  "(github.event_name == 'pull_request' && github.base_ref == 'main') || (github.event_name == 'merge_group' && github.event.merge_group.base_ref == 'refs/heads/main')";
assert.equal(gate.env.PROMOTION, `\${{ ${promotion} }}`);
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
assert.equal(
  shardJob.if,
  promotion,
  "Main pull requests and merge-queue candidates require every Quint shard",
);
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
  `\${{ always() && !cancelled() && (${promotion}) }}`,
  "The Quint aggregate must run only for promotion and stop when the whole workflow is cancelled",
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
  "node packages/scripts/check-quint-shards.ts test-results/quint-manifests 4",
);
const selection = shardJob.steps.find((step) => step.id === "changes");
assert.equal(selection.run, 'echo "run=true" >> "$GITHUB_OUTPUT"');
assert.equal(
  shardJob.steps.find((step) => step.name === "Checkout candidate source").with
    .ref,
  `\${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.event.merge_group.head_sha }}`,
);
assert.equal(
  shardGate.steps.find((step) => step.name === "Checkout verified source").with
    .ref,
  shardJob.steps.find((step) => step.name === "Checkout candidate source").with
    .ref,
);
assert.equal(validateWorkflowTriggerPolicy(root).developPushWorkflows, 1);
const canonical = parse(
  await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8"),
);
assert.equal(canonical.jobs.quint.if, "github.ref == 'refs/heads/main'");
assert.equal(
  canonical.jobs["quint-result"].if,
  `\${{ always() && !cancelled() && github.ref == 'refs/heads/main' }}`,
);
assert.deepEqual(canonical.jobs.quint.strategy.matrix.shard, [1, 2, 3, 4]);
assert.equal(
  canonical.jobs.quint.steps.find(
    (step) => step.name === "Quint application state models",
  ).run,
  `bun run test:quint --shard=\${{ matrix.shard }}/4`,
);
assert.equal(
  canonical.jobs["quint-result"].steps.find(
    (step) => step.name === "Verify complete disjoint model coverage",
  ).run,
  "node packages/scripts/check-quint-shards.ts test-results/quint-canonical-manifests 4",
);
assert(canonical.jobs.required.needs.includes("quint-result"));
const canonicalGate = canonical.jobs.required.steps.find(
  (step) => step.name === "Require every CI job to succeed",
);
assert(
  canonicalGate.env.RESULTS.includes(
    `quint-result=\${{ needs.quint-result.result }}:\${{ github.ref == 'refs/heads/main' }}`,
  ),
);
const full = parse(
  await readFile(path.join(root, ".github/workflows/develop-full.yml"), "utf8"),
);
const fullPlan = full.jobs.plan;
const dispatchGuard = fullPlan.steps.find(
  (step) => step.name === "Validate promoted dispatch authority",
);
const eventMatrix = [];
const dispatchResults = [];

for (const event of [
  "pull_request",
  "merge_group",
  "push",
  "workflow_dispatch",
]) {
  for (const branch of ["develop", "staging", "main", "feature"]) {
    const github = {
      event_name: event,
      sha: "a".repeat(40),
      ref_name: branch,
      base_ref: event === "pull_request" ? branch : "",
      ref:
        event === "pull_request"
          ? "refs/pull/1/merge"
          : event === "merge_group"
            ? `refs/heads/gh-readonly-queue/${branch}/pr-1`
            : `refs/heads/${branch}`,
      event: {
        merge_group: {
          base_ref: event === "merge_group" ? `refs/heads/${branch}` : "",
        },
      },
    };
    const evaluate = (value) =>
      Boolean(
        runInNewContext(value.replace(/^\$\{\{\s*|\s*\}\}$/g, ""), {
          github,
          inputs: { source_sha: github.sha, effect_digest: "d".repeat(64) },
          contains: (values, value) => values.includes(value),
          fromJSON: JSON.parse,
          always: () => true,
          cancelled: () => false,
        }),
      );
    const prExpected =
      branch === "main" && ["pull_request", "merge_group"].includes(event);
    assert.equal(evaluate(shardJob.if), prExpected);
    assert.equal(evaluate(shardGate.if), prExpected);
    assert.equal(evaluate(gate.env.PROMOTION), prExpected);
    // Reusable CI inherits the push/manual caller's ref; it has no independent push trigger.
    const canonicalExpected =
      branch === "main" && ["push", "workflow_dispatch"].includes(event);
    assert.equal(evaluate(canonical.jobs.quint.if), canonicalExpected);
    assert.equal(
      evaluate(canonical.jobs["quint-result"].if),
      canonicalExpected,
    );
    const fullExpected =
      ["push", "workflow_dispatch"].includes(event) &&
      ["develop", "staging", "main"].includes(branch);
    assert.equal(evaluate(fullPlan.if), fullExpected);
    eventMatrix.push({
      event,
      branch,
      prQuint: prExpected,
      canonicalQuint: canonicalExpected,
      fullPlan: fullExpected,
    });
  }
}
for (const branch of ["develop", "staging", "main"])
  for (const kind of ["heads", "tags"]) {
    const github = {
      event_name: "workflow_dispatch",
      ref: `refs/${kind}/${branch}`,
      ref_name: branch,
      sha: "a".repeat(40),
    };
    const inputs = { source_sha: github.sha, effect_digest: "d".repeat(64) };
    const selected = Boolean(
      runInNewContext(fullPlan.if.replace(/^\$\{\{\s*|\s*\}\}$/g, ""), {
        github,
        inputs,
        contains: (a, v) => a.includes(v),
        fromJSON: JSON.parse,
      }),
    );
    assert.equal(selected, kind === "heads");
    const checked = spawnSync("bash", ["-c", dispatchGuard.run], {
      cwd: root,
      env: {
        ...process.env,
        GITHUB_REF: github.ref,
        GITHUB_REF_NAME: branch,
        GITHUB_SHA: github.sha,
        SOURCE_SHA: inputs.source_sha,
        EFFECT_DIGEST: inputs.effect_digest,
      },
      encoding: "utf8",
    });
    assert.equal(checked.status, kind === "heads" ? 0 : 1);
    dispatchResults.push({
      ref: github.ref,
      planSelected: selected,
      shellExit: checked.status,
    });
  }
for (const invalid of [
  { source_sha: "b".repeat(40), effect_digest: "d".repeat(64) },
  { source_sha: "a".repeat(40), effect_digest: "" },
]) {
  const github = {
    event_name: "workflow_dispatch",
    ref: "refs/heads/main",
    ref_name: "main",
    sha: "a".repeat(40),
  };
  const selected = Boolean(
    runInNewContext(fullPlan.if.replace(/^\$\{\{\s*|\s*\}\}$/g, ""), {
      github,
      inputs: invalid,
      contains: (a, v) => a.includes(v),
      fromJSON: JSON.parse,
    }),
  );
  assert.equal(selected, false);
  const checked = spawnSync("bash", ["-c", dispatchGuard.run], {
    cwd: root,
    env: {
      ...process.env,
      GITHUB_REF: github.ref,
      GITHUB_REF_NAME: "main",
      GITHUB_SHA: github.sha,
      SOURCE_SHA: invalid.source_sha,
      EFFECT_DIGEST: invalid.effect_digest,
    },
    encoding: "utf8",
  });
  assert.equal(checked.status, 1);
  dispatchResults.push({
    ref: github.ref,
    invalidSource: invalid.source_sha !== github.sha,
    missingDigest: invalid.effect_digest === "",
    planSelected: selected,
    shellExit: checked.status,
  });
}
const output = testOutputPath("quint-ci-admission");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const results = [];
const outcomes = ["success", "failure", "cancelled", "skipped", "running"];
for (const promoted of ["true", "false"]) {
  const expected = (lane) =>
    lane === "quint" && promoted === "false" ? "skipped" : "success";
  for (const rejectedLane of [undefined, ...lanes]) {
    for (const outcome of rejectedLane
      ? outcomes.filter((value) => value !== expected(rejectedLane))
      : [undefined]) {
      const resultValues = bindings
        .map(
          (match) =>
            `${match[1]}=${match[1] === rejectedLane ? outcome : expected(match[1])}`,
        )
        .join(" ");
      const result = spawnSync("bash", ["-c", gate.run], {
        cwd: root,
        env: { ...process.env, PROMOTION: promoted, RESULTS: resultValues },
        encoding: "utf8",
        timeout: 10_000,
      });
      if (result.error) throw result.error;
      assert.equal(result.signal, null);
      assert.equal(
        result.status,
        rejectedLane ? 1 : 0,
        `Unexpected aggregate result for ${rejectedLane ?? "all lanes"}: ${outcome} (promotion ${promoted})`,
      );
      results.push({
        promotion: promoted,
        rejectedLane: rejectedLane ?? null,
        outcome: outcome ?? null,
        exitCode: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    }
  }
}
assert.equal(results.length, 58);
const canonicalResults = [];
const canonicalBindings = [
  ...canonicalGate.env.RESULTS.matchAll(
    /(\S+)=\$\{\{\s*needs\.([^\s]+)\.result\s*\}\}:(.*)/g,
  ),
];
assert.equal(canonicalBindings.length, canonical.jobs.required.needs.length);
for (const main of [true, false])
  for (const fault of [null, ...canonicalBindings.map((match) => match[1])]) {
    for (const bad of fault
      ? ["failure", "cancelled", "running", "", "skipped", "success"]
      : [null]) {
      const expected = (id) =>
        id === "quint-result" && !main ? "skipped" : "success";
      if (fault && bad === expected(fault)) continue;
      const values = canonicalBindings
        .map(
          (match) =>
            `${match[1]}=${match[1] === fault ? bad : expected(match[1])}:${match[1] === "quint-result" ? main : true}`,
        )
        .join("\n");
      const checked = spawnSync("bash", ["-c", canonicalGate.run], {
        cwd: root,
        env: { ...process.env, RESULTS: values },
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(checked.signal, null);
      assert.equal(checked.status, fault ? 1 : 0);
      canonicalResults.push({ main, fault, bad, exitCode: checked.status });
    }
  }
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
    const accepted = result === "success" && shouldRun === "true";
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
const selectorTests = spawnSync(
  process.execPath,
  [
    "--test",
    "--test-reporter=tap",
    "packages/scripts/ci-affected.integration.test.ts",
  ],
  {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  },
);
await writeFile(
  path.join(directory, "selectors.tap"),
  `${selectorTests.stdout ?? ""}${selectorTests.stderr ?? ""}`,
);
assert.equal(selectorTests.signal, null);
assert.equal(
  selectorTests.status,
  0,
  `Actual source selector failed: ${directory}`,
);
assert.match(selectorTests.stdout, /^# fail 0$/m);
assert.match(selectorTests.stdout, /^# skipped 0$/m);
const proofTests = spawnSync(
  "bun",
  [
    "test",
    "./packages/cloud/scripts/staging-release-certification.test.ts",
    "./packages/scripts/__tests__/develop-effect-ledger.test.ts",
    "--reporter=junit",
    `--reporter-outfile=${path.join(directory, "production.junit.xml")}`,
  ],
  {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    timeout: 360_000,
    maxBuffer: 8 * 1024 * 1024,
  },
);
await writeFile(
  path.join(directory, "production.log"),
  `${proofTests.stdout ?? ""}${proofTests.stderr ?? ""}`,
);
assert.equal(proofTests.signal, null);
assert.equal(
  proofTests.status,
  0,
  `Main production conformance failed: ${directory}`,
);
const junit = await readFile(
  path.join(directory, "production.junit.xml"),
  "utf8",
);
assert.equal((junit.match(/<testcase /g) ?? []).length, 84);
const proofSummary = parseJunitSummary(junit);
assert.deepEqual(
  new Map(proofSummary.files.map((file) => [file.file, file.executedTests])),
  new Map([
    ["packages/cloud/scripts/staging-release-certification.test.ts", 62],
    ["packages/scripts/__tests__/develop-effect-ledger.test.ts", 22],
  ]),
);
assert.equal(
  proofSummary.failures + proofSummary.errors + proofSummary.skipped,
  0,
);
assert(!/<(?:failure|error|skipped)[ >]/.test(junit));
for (const name of [
  "admits the complete current source manifest and an exact main manual run",
  "rechecks the actual run after download and rejects rerun, newer run, or missing manifest",
  "all three production effect consumers require main proof before their first mutation",
])
  assert(junit.includes(name), `Missing required real admission case ${name}`);
const partitions = { tests: 7, passed: 7, failed: 0, skipped: 0, cancelled: 0 };
await writeFile(
  path.join(directory, "results.json"),
  `${JSON.stringify(
    {
      status: "passed",
      workflowPath,
      workflowSha256: createHash("sha256").update(source).digest("hex"),
      results,
      canonicalResults,
      eventMatrix,
      dispatchResults,
      shardResults,
      partitions,
    },
    null,
    2,
  )}\n`,
);
console.log(
  `CI admission conformance passed 58 top-level and 18 shard shell outcomes plus canonical/event matrix, seven partition tests and 84 production/ledger tests. Results ${directory}`,
);
