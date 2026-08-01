#!/usr/bin/env node
/**
 * Enforces merge-critical GitHub Actions behavior from parsed workflow YAML.
 * The contract rejects missing dependency edges and conditional or permissive
 * quality steps, so formatting, lint, typecheck, secrets, and script tests
 * cannot silently disappear while the workflow still parses.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// createRequire, not a bare ESM import: the `changes` job runs this script
// without a workspace install, providing the parser via NODE_PATH — which
// only CommonJS resolution consults. With a workspace install the normal
// upward node_modules walk finds the same package.
const require = createRequire(import.meta.url);
const { parseDocument } = require("yaml");

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const WORKFLOW_PATHS = Object.freeze({
  cloudSetup: ".github/actions/cloud-setup-test-env/action.yml",
  cloudTests: ".github/workflows/cloud-tests.yml",
  develop: ".github/workflows/develop-pr.yml",
  gitleaks: ".github/workflows/gitleaks.yml",
  tests: ".github/workflows/test.yml",
});
const ISOLATED_BUN_HOME = `\${{ runner.temp }}/bun-home-\${{ github.run_id }}-\${{ github.run_attempt }}-\${{ github.job }}`;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function parseYamlMapping(relativePath, source) {
  const document = parseDocument(source, {
    maxAliasCount: 0,
    prettyErrors: true,
    schema: "core",
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(
      `${relativePath}: invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }
  const value = document.toJS({ maxAliasCount: 0 });
  invariant(
    value && typeof value === "object" && !Array.isArray(value),
    `${relativePath}: workflow root must be a mapping`,
  );
  return value;
}

export function parseWorkflow(relativePath, source) {
  const value = parseYamlMapping(relativePath, source);
  invariant(
    value.jobs && typeof value.jobs === "object" && !Array.isArray(value.jobs),
    `${relativePath}: jobs must be a mapping`,
  );
  return value;
}

function requireJob(workflow, workflowPath, jobName) {
  const job = workflow.jobs[jobName];
  invariant(
    job && typeof job === "object",
    `${workflowPath}: missing jobs.${jobName}`,
  );
  invariant(
    job.if === undefined,
    `${workflowPath}: jobs.${jobName} may not declare if`,
  );
  invariant(
    job["continue-on-error"] !== true,
    `${workflowPath}: jobs.${jobName} may not continue on error`,
  );
  invariant(
    Array.isArray(job.steps) && job.steps.length > 0,
    `${workflowPath}: jobs.${jobName} must contain steps`,
  );
  return job;
}

function requireCommand(job, workflowPath, jobName, command) {
  const step = job.steps.find(
    (candidate) =>
      typeof candidate?.run === "string" && candidate.run.includes(command),
  );
  invariant(step, `${workflowPath}: jobs.${jobName} must execute ${command}`);
  invariant(
    step.if === undefined,
    `${workflowPath}: ${command} may not be conditional`,
  );
  invariant(
    step["continue-on-error"] !== true,
    `${workflowPath}: ${command} may not continue on error`,
  );
  invariant(
    !/(?:\|\|\s*true\b|;\s*true\b|set\s+\+e\b)/.test(step.run),
    `${workflowPath}: ${command} is wrapped by a success-forcing shell construct`,
  );
}

function normalizedNeeds(job) {
  if (typeof job.needs === "string") return [job.needs];
  return Array.isArray(job.needs) ? job.needs : [];
}

export function validateWorkflowSources(sources) {
  const cloudSetup = parseYamlMapping(
    WORKFLOW_PATHS.cloudSetup,
    sources.cloudSetup,
  );
  const cloudTests = parseWorkflow(
    WORKFLOW_PATHS.cloudTests,
    sources.cloudTests,
  );
  const develop = parseWorkflow(WORKFLOW_PATHS.develop, sources.develop);
  const gitleaks = parseWorkflow(WORKFLOW_PATHS.gitleaks, sources.gitleaks);
  const tests = parseWorkflow(WORKFLOW_PATHS.tests, sources.tests);

  const cloudE2e = requireJob(
    cloudTests,
    WORKFLOW_PATHS.cloudTests,
    "e2e-tests",
  );
  invariant(
    cloudE2e["runs-on"] === "ubuntu-24.04",
    `${WORKFLOW_PATHS.cloudTests}: jobs.e2e-tests must use the Docker-capable ubuntu-24.04 runner`,
  );
  const cloudSetupInvocation = cloudE2e.steps.find(
    (step) => step?.uses === "./.github/actions/cloud-setup-test-env",
  );
  invariant(
    cloudSetupInvocation?.with?.["setup-db"] === "true" &&
      cloudSetupInvocation.with["db-backend"] === "postgres",
    `${WORKFLOW_PATHS.cloudTests}: jobs.e2e-tests must explicitly request real PostgreSQL`,
  );
  requireCommand(
    cloudE2e,
    WORKFLOW_PATHS.cloudTests,
    "e2e-tests",
    "agent-sandboxes-stuck-provisioning-lock.integration.test.ts",
  );
  requireCommand(
    cloudE2e,
    WORKFLOW_PATHS.cloudTests,
    "e2e-tests",
    "bun run test:cloud:e2e",
  );

  invariant(
    cloudSetup.runs?.using === "composite" &&
      Array.isArray(cloudSetup.runs.steps),
    `${WORKFLOW_PATHS.cloudSetup}: runs.steps must be a composite step list`,
  );
  const cloudSetupSteps = cloudSetup.runs.steps;
  const dockerPreflightIndex = cloudSetupSteps.findIndex(
    (step) => typeof step?.run === "string" && step.run.includes("docker info"),
  );
  invariant(
    dockerPreflightIndex === 0,
    `${WORKFLOW_PATHS.cloudSetup}: Docker daemon preflight must run before setup, install, cache, or build work`,
  );
  const dockerPreflight = cloudSetupSteps[dockerPreflightIndex];
  invariant(
    dockerPreflight.if ===
      "inputs.setup-db == 'true' && inputs.db-backend == 'postgres'",
    `${WORKFLOW_PATHS.cloudSetup}: Docker preflight must cover every PostgreSQL setup`,
  );
  invariant(
    dockerPreflight["continue-on-error"] !== true &&
      !/(?:\|\|\s*true\b|;\s*true\b|set\s+\+e\b)/.test(dockerPreflight.run),
    `${WORKFLOW_PATHS.cloudSetup}: Docker preflight must fail closed`,
  );
  invariant(
    !cloudSetupSteps.some((step) => step?.uses?.startsWith("actions/cache@")),
    `${WORKFLOW_PATHS.cloudSetup}: multi-gigabyte Bun install archives are prohibited`,
  );
  const cloudSetupBun = cloudSetupSteps.find((step) =>
    step?.uses?.startsWith("oven-sh/setup-bun@"),
  );
  invariant(
    cloudSetupBun?.env?.HOME === ISOLATED_BUN_HOME,
    `${WORKFLOW_PATHS.cloudSetup}: setup-bun HOME must be isolated by run, attempt, and job without space-bearing runner metadata`,
  );
  const postgresStart = cloudSetupSteps.find(
    (step) =>
      typeof step?.run === "string" &&
      step.run.includes("docker run") &&
      step.run.includes("pgvector/pgvector:pg16"),
  );
  invariant(
    postgresStart?.if ===
      "inputs.setup-db == 'true' && inputs.db-backend == 'postgres'",
    `${WORKFLOW_PATHS.cloudSetup}: real pgvector startup must cover PostgreSQL setup`,
  );
  const migrations = cloudSetupSteps.find(
    (step) =>
      typeof step?.run === "string" && step.run.includes("bun run db:migrate"),
  );
  invariant(
    migrations?.if === "inputs.setup-db == 'true'" &&
      migrations["continue-on-error"] !== true,
    `${WORKFLOW_PATHS.cloudSetup}: database migrations must remain fail-closed for setup-db`,
  );

  const lint = requireJob(develop, WORKFLOW_PATHS.develop, "lint");
  requireCommand(lint, WORKFLOW_PATHS.develop, "lint", "bun run lint:check");
  requireCommand(lint, WORKFLOW_PATHS.develop, "lint", "bun run format:check");

  const typecheck = requireJob(develop, WORKFLOW_PATHS.develop, "typecheck");
  requireCommand(
    typecheck,
    WORKFLOW_PATHS.develop,
    "typecheck",
    "run typecheck",
  );

  const secrets = requireJob(gitleaks, WORKFLOW_PATHS.gitleaks, "gitleaks");
  requireCommand(
    secrets,
    WORKFLOW_PATHS.gitleaks,
    "gitleaks",
    "gitleaks detect",
  );

  const quality = requireJob(tests, WORKFLOW_PATHS.tests, "merge-quality-gate");
  requireCommand(
    quality,
    WORKFLOW_PATHS.tests,
    "merge-quality-gate",
    "bun run lint:check",
  );
  requireCommand(
    quality,
    WORKFLOW_PATHS.tests,
    "merge-quality-gate",
    "bun run format:check",
  );
  requireCommand(
    quality,
    WORKFLOW_PATHS.tests,
    "merge-quality-gate",
    "run typecheck",
  );
  requireCommand(
    quality,
    WORKFLOW_PATHS.tests,
    "merge-quality-gate",
    "gitleaks detect",
  );

  const scripts = requireJob(tests, WORKFLOW_PATHS.tests, "script-tests");
  requireCommand(
    scripts,
    WORKFLOW_PATHS.tests,
    "script-tests",
    "bun run test:scripts",
  );

  const finalGate = tests.jobs["ci-ok"];
  invariant(finalGate, `${WORKFLOW_PATHS.tests}: missing jobs.ci-ok`);
  const needs = normalizedNeeds(finalGate);
  for (const dependency of ["merge-quality-gate", "script-tests"]) {
    invariant(
      needs.includes(dependency),
      `${WORKFLOW_PATHS.tests}: jobs.ci-ok must need ${dependency}`,
    );
  }
  return { ok: true };
}

export function run(repoRoot = REPO_ROOT) {
  return validateWorkflowSources({
    cloudSetup: readFileSync(
      path.join(repoRoot, WORKFLOW_PATHS.cloudSetup),
      "utf8",
    ),
    cloudTests: readFileSync(
      path.join(repoRoot, WORKFLOW_PATHS.cloudTests),
      "utf8",
    ),
    develop: readFileSync(path.join(repoRoot, WORKFLOW_PATHS.develop), "utf8"),
    gitleaks: readFileSync(
      path.join(repoRoot, WORKFLOW_PATHS.gitleaks),
      "utf8",
    ),
    tests: readFileSync(path.join(repoRoot, WORKFLOW_PATHS.tests), "utf8"),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run();
  process.stdout.write(
    "ci-workflow-invariants: merge-critical workflow contract passed\n",
  );
}
