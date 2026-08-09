#!/usr/bin/env node
/**
 * Workflow-to-root-script existence contract: parses every workflow file in
 * `.github/workflows/` (including ci.yaml), extracts `bun run <name>` /
 * `npm run <name>` / `yarn <name>` invocations from `run:` steps, and asserts
 * each referenced name resolves to a real script defined in root `package.json`.
 *
 * Closes the gap from #18090: a workflow step calling a deleted root script
 * (the dangling `clean:stale-js` step) silently passed every existing audit
 * because:
 *   - audit-scripts.mjs checks broken paths inside root script bodies, but does
 *     not parse workflow `run:` steps.
 *   - audit-scripts-inventory.mjs discovers workflow script names, but
 *     reachableRootScripts() silently skips any name absent from rootScripts.
 *   - ci-workflow-invariants.mjs does not load ci.yaml at all.
 *
 * Usage:
 *   node packages/scripts/audit-workflow-scripts.mjs            # audit the repo
 *   node packages/scripts/audit-workflow-scripts.mjs --json     # machine-readable
 *   node packages/scripts/audit-workflow-scripts.mjs --root DIR # fixture tree
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// createRequire, not a bare ESM import: follows the same pattern as
// ci-workflow-invariants.mjs for cross-environment yaml resolution.
const require = createRequire(import.meta.url);
const { parseDocument } = require("yaml");

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

/** Built-in bun/npm/yarn subcommands that are NOT script references. */
const BUILTIN_COMMANDS = new Set([
  "install",
  "add",
  "remove",
  "rm",
  "update",
  "upgrade",
  "unlink",
  "link",
  "create",
  "init",
  "publish",
  "pack",
  "cache",
  "config",
  "login",
  "logout",
  "whoami",
  "token",
  "org",
  "team",
  "report",
  "doctor",
  "completions",
  "help",
  "info",
  "view",
  "access",
  "owner",
  "deprecate",
  "dist-tag",
  "version",
  "explain",
  "find",
  "fix",
  "prune",
  "rebuild",
  "run-script",
  "set",
  "get",
  "test",
  "bin",
  "ls",
  "outdated",
  "audit",
  "fund",
  "hook",
  "diff",
  "ci",
  "exec",
  "dlx",
  "x",
  "help",
  "pm",
  "repo",
]);

/**
 * Extracts npm-style script names from a shell `run:` step string. Matches
 * `bun run <name>`, `npm run <name>`, `yarn run <name>`, and bare
 * `yarn <name>` (but NOT `yarn install`, `yarn add`, etc.).
 *
 * Filters out:
 *   - Names that are immediately followed by `/` (file paths like
 *     `bun run packages/agent/dist/index.js`).
 *   - Built-in subcommands (install, add, publish, etc.).
 *   - Names starting with `-`, `.`, `/`, `$`, `~` (flags, files, variables).
 */
function extractScriptInvocations(stepRun) {
  const names = [];
  // Match `bun run <name>`, `npm run <name>`, `yarn run <name>` — the `run`
  // keyword is REQUIRED (separates script refs from file execution / installs).
  const runPattern =
    /(?:^|&&|\||;|\n)\s*(?:bun|npm|yarn)\s+run\s+(?![-./~$])([A-Za-z0-9][A-Za-z0-9:_-]*)/g;
  // Match bare `yarn <name>` — yarn runs scripts without `run`, but NOT
  // built-in commands like `yarn install` / `yarn add`.
  const yarnBarePattern =
    /(?:^|&&|\||;|\n)\s*yarn\s+(?![-./~$])([A-Za-z0-9][A-Za-z0-9:_-]*)/g;

  for (const pattern of [runPattern, yarnBarePattern]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(stepRun);
    while (match !== null) {
      const name = match[1];
      // Skip if immediately followed by `/` (file path, not script ref).
      const afterName = stepRun.slice(match.index + match[0].length);
      if (afterName.startsWith("/")) {
        match = pattern.exec(stepRun);
        continue;
      }
      // Skip built-in commands.
      if (BUILTIN_COMMANDS.has(name)) {
        match = pattern.exec(stepRun);
        continue;
      }
      // Deduplicate within the same step.
      if (!names.includes(name)) names.push(name);
      match = pattern.exec(stepRun);
    }
  }
  return names;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function parseWorkflowJobs(source) {
  const document = parseDocument(source, {
    maxAliasCount: 0,
    prettyErrors: true,
    schema: "core",
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(
      `invalid YAML: ${document.errors.map((e) => e.message).join("; ")}`,
    );
  }
  return document.toJS({ maxAliasCount: 0 });
}

function findRunSteps(workflow, results, context) {
  if (!workflow || typeof workflow !== "object") return;
  const jobs = workflow.jobs;
  if (!jobs || typeof jobs !== "object") return;

  for (const [jobName, job] of Object.entries(jobs)) {
    if (!job || typeof job !== "object") continue;
    // Job-level defaults run uses job's working-directory if set.
    const jobWorkdir =
      typeof job["working-directory"] === "string"
        ? job["working-directory"]
        : undefined;
    const steps = Array.isArray(job.steps) ? job.steps : [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step || typeof step !== "object") continue;
      if (typeof step.run !== "string") continue;
      // Step-level working-directory overrides job-level; if neither is set,
      // the invocation targets the ROOT package.json scripts.
      const stepWorkdir =
        typeof step["working-directory"] === "string"
          ? step["working-directory"]
          : jobWorkdir;
      if (stepWorkdir) continue; // targets a sub-package, not root
      const names = extractScriptInvocations(step.run);
      for (const name of names) {
        results.push({ ...context, job: jobName, step: i, script: name });
      }
    }
  }
}

/** Pre-existing workflow→root-script drift at the time this contract was
 * introduced (#18090). These are NOT caused by this PR and are tracked
 * separately — the contract must pass on the #18090 branch while still
 * catching NEW drift. Remove entries as they are fixed. */
const KNOWN_DRIFT = new Set([
  // ci.yaml lint-and-format references removed check:secrets
  "ci.yaml:lint-and-format:check:secrets",
  // cloud-gateway workflows reference removed preflight:messaging-gateways
  "cloud-gateway-discord.yml:test:preflight:messaging-gateways",
  "cloud-gateway-webhook.yml:test:preflight:messaging-gateways",
  // quality.yml develop-static-gate references removed check:secrets
  "quality.yml:develop-static-gate:check:secrets",
  // release-electrobun references removed test:desktop:playwright
  "release-electrobun.yml:build:test:desktop:playwright",
]);

function auditWorkflowScripts(root) {
  const rootPkgPath = path.join(root, "package.json");
  if (!existsSync(rootPkgPath)) {
    return [
      {
        kind: "missing-package-json",
        message: `root package.json not found at ${rootPkgPath}`,
      },
    ];
  }
  const rootPkg = readJson(rootPkgPath);
  const rootScripts = new Set(Object.keys(rootPkg.scripts ?? {}));

  const workflowDir = path.join(root, ".github", "workflows");
  if (!existsSync(workflowDir)) {
    return [];
  }

  const findings = [];
  const files = readdirSync(workflowDir).filter(
    (name) => name.endsWith(".yml") || name.endsWith(".yaml"),
  );

  for (const file of files) {
    const filePath = path.join(workflowDir, file);
    const source = readFileSync(filePath, "utf8");
    let workflow;
    try {
      workflow = parseWorkflowJobs(source);
    } catch (error) {
      findings.push({
        kind: "parse-error",
        file,
        message: `failed to parse ${file}: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    const scriptRefs = [];
    findRunSteps(workflow, scriptRefs, { file });

    for (const ref of scriptRefs) {
      const driftKey = `${ref.file}:${ref.job}:${ref.script}`;
      if (!rootScripts.has(ref.script) && !KNOWN_DRIFT.has(driftKey)) {
        findings.push({
          kind: "missing-script",
          file: ref.file,
          job: ref.job,
          step: ref.step,
          script: ref.script,
          message: `workflow "${ref.file}" job "${ref.job}" step ${ref.step} references "bun run ${ref.script}" but no root package.json script named "${ref.script}" exists`,
        });
      }
    }
  }

  return findings;
}

// --- CLI ---
const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const rootArgIdx = args.indexOf("--root");
const root =
  rootArgIdx !== -1 && args[rootArgIdx + 1]
    ? path.resolve(args[rootArgIdx + 1])
    : DEFAULT_ROOT;

const findings = auditWorkflowScripts(root);

if (jsonMode) {
  process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
} else if (findings.length === 0) {
  console.log(
    "audit-workflow-scripts: all workflow script references resolve to root package.json scripts",
  );
} else {
  console.error(
    `audit-workflow-scripts: ${findings.length} finding(s):\n` +
      findings
        .map(
          (f) =>
            `- [${f.kind}] ${f.message ?? `file ${f.file} job ${f.job} step ${f.step}: script "${f.script}" not found`}`,
        )
        .join("\n"),
  );
  process.exit(1);
}
