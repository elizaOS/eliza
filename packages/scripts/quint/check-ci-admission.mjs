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
  "always()",
  "The aggregate must evaluate failed and cancelled dependencies",
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
await writeFile(
  path.join(directory, "results.json"),
  `${JSON.stringify({ status: "passed", workflowPath, workflowSha256: createHash("sha256").update(source).digest("hex"), results }, null, 2)}\n`,
);
console.log(
  `CI admission conformance passed 29 actual shell outcomes. Results ${directory}`,
);
