#!/usr/bin/env node
/**
 * Contract that keeps the develop merge gate robust against a self-hosted
 * single-point-of-failure while staying a real gate (#13617). Runs in test.yml's
 * `changes` job; a violation fails the branch's CI.
 *
 * Three invariants, each guarding one failure mode the issue documents:
 *
 *   1. Path classifiers stay GitHub-hosted. Every `Classify changed paths` job
 *      is a git-diff + node script; when it was pinned to the hetzner-robot
 *      fleet a drained fleet left it queued forever and every downstream job
 *      (and the required `ci-ok`) wedged with it (#8501 gridlock). It must run
 *      on `ubuntu-24.04`.
 *
 *   2. Heavy self-hosted jobs carry the fleet-drain fallback. `ci-ok` needs the
 *      test lanes, which run on the hetzner-robot fleet. There is no way to
 *      probe fleet health from a `runs-on:` expression, so an operator toggle
 *      (`vars.HETZNER_FLEET_ONLINE`) flips the whole workflow to hosted during
 *      an outage — replacing per-PR admin-bypass with one repo-variable flip.
 *      No test.yml job may hardcode a bare `[self-hosted, hetzner-robot]`.
 *
 *   3. `ci-ok` needs the hosted quality gate. The merge queue's sole required
 *      context is `ci-ok`; before #13617 it needed only test lanes, so a lint /
 *      format / typecheck / stale-base / secret regression (all required on
 *      `main`) could merge to develop. `ci-ok` must need `merge-quality-gate`,
 *      and that job must run lint + format:check + typecheck + stale-base +
 *      a gitleaks secret scan on a hosted runner so it gates regardless of
 *      fleet health.
 *
 * Text-scans the workflow YAML (no yaml dependency, matching the sibling
 * ci-*-contract.mjs scripts). `--self-test` proves the checker against synthetic
 * pass/fail fixtures so a broken checker cannot vacuously pass.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO_ROOT = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
);

const CLASSIFIER_WORKFLOWS = [
  "test.yml",
  "scenario-pr.yml",
  "dev-smoke.yml",
  "docker-ci-smoke.yml",
  "mobile-build-smoke.yml",
  "windows-dev-smoke.yml",
  "windows-desktop-preload-smoke.yml",
];

const FLEET_FALLBACK_VAR = "HETZNER_FLEET_ONLINE";
const BARE_SELF_HOSTED = /runs-on:\s*\[\s*self-hosted\s*,\s*hetzner-robot\s*\]/;

/**
 * The `Classify changed paths` job's `runs-on:` value, read from the two lines
 * that follow its `name:`. Returns null when the job is absent.
 */
function classifierRunsOn(text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s+name:\s*Classify changed paths\s*$/.test(lines[i])) {
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j += 1) {
        const m = lines[j].match(/^\s+runs-on:\s*(.+?)\s*$/);
        if (m) return m[1];
      }
    }
  }
  return null;
}

/** Every bare self-hosted `runs-on:` line, with 1-based line numbers. */
function bareSelfHostedLines(text) {
  return text
    .split(/\r?\n/)
    .map((line, idx) => ({ line, no: idx + 1 }))
    .filter(({ line }) => BARE_SELF_HOSTED.test(line));
}

/** The `needs:` block for a named job as a set of job ids. */
function jobNeeds(text, jobId) {
  const lines = text.split(/\r?\n/);
  const header = lines.findIndex((l) =>
    new RegExp(`^  ${jobId}:\\s*$`).test(l),
  );
  if (header < 0) return null;
  const needs = new Set();
  let inNeeds = false;
  for (let i = header + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^ {2}\S/.test(line)) break; // next top-level job
    if (/^ {4}needs:\s*$/.test(line)) {
      inNeeds = true;
      continue;
    }
    if (inNeeds) {
      const m = line.match(/^ {6}- (\S+)\s*$/);
      if (m) {
        needs.add(m[1]);
        continue;
      }
      if (/^\s{4}\S/.test(line)) inNeeds = false; // next key at job level
    }
  }
  return needs;
}

/** The raw body of a named job (its lines up to the next top-level job). */
function jobBody(text, jobId) {
  const lines = text.split(/\r?\n/);
  const header = lines.findIndex((l) =>
    new RegExp(`^  ${jobId}:\\s*$`).test(l),
  );
  if (header < 0) return null;
  const body = [];
  for (let i = header + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join("\n");
}

function checkWorkflowText(fileName, text, problems) {
  const runsOn = classifierRunsOn(text);
  if (fileName === "test.yml" && runsOn === null) {
    // test.yml must own the classifier; other files might legitimately drop it.
    problems.push(`${fileName}: no 'Classify changed paths' job found`);
  }
  if (runsOn !== null && !runsOn.startsWith("ubuntu-")) {
    problems.push(
      `${fileName}: 'Classify changed paths' runs-on is '${runsOn}', expected a GitHub-hosted ubuntu-* runner (a drained self-hosted fleet must not wedge the classifier)`,
    );
  }

  if (fileName === "test.yml") {
    for (const { no } of bareSelfHostedLines(text)) {
      problems.push(
        `test.yml:${no}: bare '[self-hosted, hetzner-robot]' runs-on — must use the '${FLEET_FALLBACK_VAR}' fallback expression so an operator can drain the fleet to hosted`,
      );
    }
    if (!text.includes(`vars.${FLEET_FALLBACK_VAR}`)) {
      problems.push(
        `test.yml: missing the '${FLEET_FALLBACK_VAR}' fleet-drain fallback expression on the self-hosted lanes`,
      );
    }

    const ciOkNeeds = jobNeeds(text, "ci-ok");
    if (!ciOkNeeds) {
      problems.push("test.yml: no 'ci-ok' job found");
    } else if (!ciOkNeeds.has("merge-quality-gate")) {
      problems.push(
        "test.yml: 'ci-ok' does not need 'merge-quality-gate' — the merge queue would not enforce lint/format/typecheck/secret gates",
      );
    }

    const gate = jobBody(text, "merge-quality-gate");
    if (gate === null) {
      problems.push("test.yml: no 'merge-quality-gate' job found");
    } else {
      if (!/runs-on:\s*ubuntu-/.test(gate)) {
        problems.push(
          "test.yml: 'merge-quality-gate' must run on a GitHub-hosted ubuntu runner so it gates independent of fleet health",
        );
      }
      const required = [
        { label: "lint", pattern: /bun run lint\b/ },
        { label: "format:check", pattern: /bun run format:check\b/ },
        { label: "typecheck", pattern: /bun run typecheck\b/ },
        {
          label: "stale-base guard",
          pattern: /stale-base-guard\.mjs[\s\S]*--merge-base/,
        },
        { label: "gitleaks secret scan", pattern: /gitleaks detect\b/ },
        {
          label: "merge-commit gitleaks patch scan",
          pattern: /--log-opts "-m -p -1 \$\{CURRENT_SHA\}"/,
        },
      ];
      for (const { label, pattern } of required) {
        if (!pattern.test(gate)) {
          problems.push(
            `test.yml: 'merge-quality-gate' is missing the ${label} step`,
          );
        }
      }
    }
  }
}

function run(repoRoot) {
  const problems = [];
  for (const fileName of CLASSIFIER_WORKFLOWS) {
    const path = resolve(repoRoot, ".github/workflows", fileName);
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      problems.push(`${fileName}: workflow file not found at ${path}`);
      continue;
    }
    checkWorkflowText(fileName, text, problems);
  }
  return problems;
}

function selfTest() {
  const good = `jobs:
  changes:
    name: Classify changed paths
    runs-on: ubuntu-24.04
    timeout-minutes: 10
  server-tests:
    name: Server Tests
    needs: changes
    runs-on: \${{ fromJSON(vars.HETZNER_FLEET_ONLINE == 'false' && '["ubuntu-24.04"]' || '["self-hosted","hetzner-robot"]') }}
  merge-quality-gate:
    name: Merge Queue Quality Gate
    needs: changes
    runs-on: ubuntu-24.04
    steps:
      - run: bun run lint
      - run: bun run format:check
      - run: bun run typecheck
      - run: node packages/scripts/stale-base-guard.mjs --base "$BASE_SHA" --head "$CURRENT_SHA" --merge-base "$BASE_SHA"
      - run: gitleaks detect --source . --log-opts "-m -p -1 \${CURRENT_SHA}"
  ci-ok:
    name: ci-ok
    needs:
      - changes
      - merge-quality-gate
      - server-tests
`;
  const goodProblems = [];
  checkWorkflowText("test.yml", good, goodProblems);
  if (goodProblems.length !== 0) {
    throw new Error(
      `self-test: valid fixture reported problems:\n  ${goodProblems.join("\n  ")}`,
    );
  }

  const badCases = [
    {
      name: "self-hosted classifier",
      text: good.replace(
        "runs-on: ubuntu-24.04\n    timeout-minutes",
        "runs-on: [self-hosted, hetzner-robot]\n    timeout-minutes",
      ),
    },
    {
      name: "bare self-hosted lane",
      text: good.replace(
        /runs-on: \$\{\{ fromJSON[^\n]+\}\}/,
        "runs-on: [self-hosted, hetzner-robot]",
      ),
    },
    {
      name: "ci-ok missing merge-quality-gate",
      text: good.replace("      - merge-quality-gate\n", ""),
    },
    {
      name: "gate missing typecheck",
      text: good.replace("      - run: bun run typecheck\n", ""),
    },
    {
      name: "gate missing secret scan",
      text: good.replace(/^ {6}- run: gitleaks detect .*\n/m, ""),
    },
    {
      name: "gate missing stale-base guard",
      text: good.replace(
        '      - run: node packages/scripts/stale-base-guard.mjs --base "$BASE_SHA" --head "$CURRENT_SHA" --merge-base "$BASE_SHA"\n',
        "",
      ),
    },
    {
      name: "gate gitleaks missing merge-commit patch mode",
      text: good.replace(/--log-opts "-m -p -1 \$\{CURRENT_SHA\}"/, ""),
    },
  ];
  for (const { name, text } of badCases) {
    const problems = [];
    checkWorkflowText("test.yml", text, problems);
    if (problems.length === 0) {
      throw new Error(`self-test: invalid fixture '${name}' was not caught`);
    }
  }
  console.log("ci-merge-gate-contract self-test: 8 cases passed");
}

function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }
  const problems = run(DEFAULT_REPO_ROOT);
  if (problems.length > 0) {
    console.error("Merge-gate contract violations:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    "ci-merge-gate-contract: classifiers hosted, fleet-drain fallback present, ci-ok enforces the hosted quality gate.",
  );
}

main();
