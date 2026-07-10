#!/usr/bin/env node
/**
 * Enforces the workflow structure that makes `ci-ok` a real develop merge gate
 * while allowing operators to drain the self-hosted fleet (#13617). Classifiers
 * and required test lanes retain a hosted fallback; `ci-ok` owns lint, format,
 * type, stale-base, and secret checks; and the lightweight develop PR lane runs
 * formatting before merge because superseded post-merge runs cannot reliably
 * be the first detector (#15959).
 *
 * The checker text-scans YAML to avoid a workflow-time parser dependency. Its
 * synthetic self-test must reject every missing dependency or command so the
 * contract cannot pass vacuously.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO_ROOT = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
);

const CONTRACT_WORKFLOWS = [
  "test.yml",
  "scenario-pr.yml",
  "dev-smoke.yml",
  "docker-ci-smoke.yml",
  "mobile-build-smoke.yml",
  "windows-dev-smoke.yml",
  "windows-desktop-preload-smoke.yml",
  "develop-pr.yml",
];

const DEVELOP_PR_WORKFLOW = "develop-pr.yml";

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
      for (let j = i + 1; j < Math.min(i + 16, lines.length); j += 1) {
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
    const inlineNeeds = line.match(/^ {4}needs:\s*(\S+)\s*$/);
    if (inlineNeeds) {
      needs.add(inlineNeeds[1]);
      continue;
    }
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

function hasFleetFallback(value) {
  return (
    value.includes(`vars.${FLEET_FALLBACK_VAR}`) &&
    value.includes("ubuntu-") &&
    value.includes("self-hosted") &&
    value.includes("hetzner-robot")
  );
}

function hasHostedRunnerOrFleetFallback(value) {
  return value.startsWith("ubuntu-") || hasFleetFallback(value);
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
  if (runsOn !== null && !hasHostedRunnerOrFleetFallback(runsOn)) {
    problems.push(
      `${fileName}: 'Classify changed paths' runs-on is '${runsOn}', expected ubuntu-* or the ${FLEET_FALLBACK_VAR} hosted fallback expression (a drained self-hosted fleet must not wedge the classifier)`,
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
    } else if (!ciOkNeeds.has("stale-base-preflight")) {
      problems.push(
        "test.yml: 'ci-ok' does not need 'stale-base-preflight' — stale PRs could skip the test fan-out without failing the required aggregate",
      );
    }

    const preflight = jobBody(text, "stale-base-preflight");
    if (preflight === null) {
      problems.push("test.yml: no 'stale-base-preflight' job found");
    } else {
      const preflightRunsOn =
        preflight.match(/^\s+runs-on:\s*(.+?)\s*$/m)?.[1] ?? "";
      if (!hasHostedRunnerOrFleetFallback(preflightRunsOn)) {
        problems.push(
          `test.yml: 'stale-base-preflight' runs-on is '${preflightRunsOn || "missing"}', expected ubuntu-* or the ${FLEET_FALLBACK_VAR} hosted fallback expression`,
        );
      }
      if (!/github\.event_name\s*==\s*'pull_request'/.test(preflight)) {
        problems.push(
          "test.yml: 'stale-base-preflight' must be PR-only so non-PR ci-ok lanes keep using merge-quality-gate",
        );
      }
      if (!/actions\/setup-node@/.test(preflight)) {
        problems.push(
          "test.yml: 'stale-base-preflight' must set up Node before running the stale-base guard scripts",
        );
      }
      if (
        !/HEAD_REPO:[\s\S]*github\.event\.pull_request\.head\.repo\.full_name/.test(
          preflight,
        )
      ) {
        problems.push(
          "test.yml: 'stale-base-preflight' must fetch the PR head from the head repository so fork PRs are supported",
        );
      }
      if (
        !/https:\/\/github\.com\/\$\{HEAD_REPO\}\.git[\s\S]*"\$HEAD_SHA"/.test(
          preflight,
        )
      ) {
        problems.push(
          "test.yml: 'stale-base-preflight' fetch must use the PR head repository URL for HEAD_SHA",
        );
      }
      if (!/stale-base-guard\.mjs[\s\S]*--head "\$HEAD_SHA"/.test(preflight)) {
        problems.push(
          "test.yml: 'stale-base-preflight' is missing the PR-head stale-base guard step",
        );
      }
    }

    const changesNeeds = jobNeeds(text, "changes");
    const changes = jobBody(text, "changes");
    if (!changesNeeds?.has("stale-base-preflight")) {
      problems.push(
        "test.yml: 'changes' must need 'stale-base-preflight' so stale PRs fail before test fanout",
      );
    }
    if (changes === null) {
      problems.push("test.yml: no 'changes' job found");
    } else {
      if (
        !/needs\.stale-base-preflight\.result\s*==\s*'success'/.test(changes)
      ) {
        problems.push(
          "test.yml: 'changes' must require stale-base-preflight success for pull_request fanout",
        );
      }
      if (!/github\.event_name\s*!=\s*'pull_request'/.test(changes)) {
        problems.push(
          "test.yml: 'changes' must continue for non-PR events where stale-base-preflight is skipped",
        );
      }
    }

    const gate = jobBody(text, "merge-quality-gate");
    if (gate === null) {
      problems.push("test.yml: no 'merge-quality-gate' job found");
    } else {
      const gateRunsOn = gate.match(/^\s+runs-on:\s*(.+?)\s*$/m)?.[1] ?? "";
      if (!hasHostedRunnerOrFleetFallback(gateRunsOn)) {
        problems.push(
          `test.yml: 'merge-quality-gate' runs-on is '${gateRunsOn || "missing"}', expected ubuntu-* or the ${FLEET_FALLBACK_VAR} hosted fallback expression`,
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

  if (fileName === DEVELOP_PR_WORKFLOW) {
    const lintJob = jobBody(text, "lint");
    if (lintJob === null) {
      problems.push(`${fileName}: no 'lint' job found`);
    } else {
      if (!/bun run lint\b/.test(lintJob)) {
        problems.push(`${fileName}: 'lint' job is missing bun run lint`);
      }
      if (!/bun run format:check\b/.test(lintJob)) {
        problems.push(
          `${fileName}: 'lint' job is missing bun run format:check — formatting regressions would first surface after merge`,
        );
      }
    }
  }
}

function run(repoRoot) {
  const problems = [];
  for (const fileName of CONTRACT_WORKFLOWS) {
    const path = resolve(repoRoot, ".github/workflows", fileName);
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      // error-policy:J1 the CLI reports unreadable required workflows as contract violations
      problems.push(
        `${fileName}: workflow file could not be read at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    checkWorkflowText(fileName, text, problems);
  }
  return problems;
}

function selfTest() {
  const good = `jobs:
  stale-base-preflight:
    name: PR stale-base preflight
    if: github.event_name == 'pull_request'
    runs-on: \${{ fromJSON(vars.HETZNER_FLEET_ONLINE == 'false' && '["ubuntu-24.04"]' || '["self-hosted","hetzner-robot"]') }}
    env:
      HEAD_REPO: \${{ github.event.pull_request.head.repo.full_name }}
    steps:
      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e
      - run: node packages/scripts/stale-base-guard.mjs --base "refs/remotes/origin/\${BASE_REF}" --head "$HEAD_SHA"
      - run: git fetch "https://github.com/\${HEAD_REPO}.git" "$HEAD_SHA"
  changes:
    name: Classify changed paths
    needs: stale-base-preflight
    if: always() && (github.event_name != 'pull_request' || needs.stale-base-preflight.result == 'success')
    runs-on: \${{ fromJSON(vars.HETZNER_FLEET_ONLINE == 'false' && '["ubuntu-24.04"]' || '["self-hosted","hetzner-robot"]') }}
    timeout-minutes: 10
  server-tests:
    name: Server Tests
    needs: changes
    runs-on: \${{ fromJSON(vars.HETZNER_FLEET_ONLINE == 'false' && '["ubuntu-24.04"]' || '["self-hosted","hetzner-robot"]') }}
  merge-quality-gate:
    name: Merge Queue Quality Gate
    needs: changes
    runs-on: \${{ fromJSON(vars.HETZNER_FLEET_ONLINE == 'false' && '["ubuntu-24.04"]' || '["self-hosted","hetzner-robot"]') }}
    steps:
      - run: bun run lint
      - run: bun run format:check
      - run: bun run typecheck
      - run: node packages/scripts/stale-base-guard.mjs --base "$BASE_SHA" --head "$CURRENT_SHA" --merge-base "$BASE_SHA"
      - run: gitleaks detect --source . --log-opts "-m -p -1 \${CURRENT_SHA}"
  ci-ok:
    name: ci-ok
    needs:
      - stale-base-preflight
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
        /runs-on: \$\{\{ fromJSON[^\n]+\}\}\n {4}timeout-minutes/,
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
      name: "ci-ok missing stale-base preflight",
      text: good.replace("      - stale-base-preflight\n", ""),
    },
    {
      name: "missing stale-base preflight job",
      text: good.replace(
        / {2}stale-base-preflight:[\s\S]*?(?= {2}changes:\n)/,
        "",
      ),
    },
    {
      name: "preflight not PR-only",
      text: good.replace("if: github.event_name == 'pull_request'", ""),
    },
    {
      name: "preflight missing node setup",
      text: good.replace(
        "      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e\n",
        "",
      ),
    },
    {
      name: "preflight missing head repo env",
      text: good.replace(
        "      HEAD_REPO: $" +
          "{{ github.event.pull_request.head.repo.full_name }}\n",
        "",
      ),
    },
    {
      name: "preflight fetches head from origin",
      text: good.replace(
        'git fetch "https://github.com/$' + '{HEAD_REPO}.git" "$HEAD_SHA"',
        'git fetch origin "$HEAD_SHA"',
      ),
    },
    {
      name: "changes missing preflight need",
      text: good.replace("    needs: stale-base-preflight\n", ""),
    },
    {
      name: "changes missing preflight success gate",
      text: good.replace(
        " || needs.stale-base-preflight.result == 'success'",
        "",
      ),
    },
    {
      name: "changes missing non-PR continuation",
      text: good.replace("github.event_name != 'pull_request' || ", ""),
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
  const goodDevelopPr = `jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: bun run lint
      - run: bun run format:check
`;
  const developProblems = [];
  checkWorkflowText(DEVELOP_PR_WORKFLOW, goodDevelopPr, developProblems);
  if (developProblems.length !== 0) {
    throw new Error(
      `self-test: valid develop PR fixture reported problems:\n  ${developProblems.join("\n  ")}`,
    );
  }
  for (const command of ["bun run lint", "bun run format:check"]) {
    const problems = [];
    checkWorkflowText(
      DEVELOP_PR_WORKFLOW,
      goodDevelopPr.replace(`      - run: ${command}\n`, ""),
      problems,
    );
    if (problems.length === 0) {
      throw new Error(
        `self-test: develop PR fixture missing '${command}' was not caught`,
      );
    }
  }
  console.log(
    `ci-merge-gate-contract self-test: ${badCases.length + 4} cases passed`,
  );
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
    "ci-merge-gate-contract: classifiers have hosted fallback, fleet-drain fallback present, develop PRs check formatting, and ci-ok enforces the quality gate.",
  );
}

main();
