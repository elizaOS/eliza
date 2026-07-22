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

function indentation(line) {
  return line.match(/^[ \t]*/)?.[0].replaceAll("\t", "  ").length ?? 0;
}

function isCommentOnlyLine(line) {
  return line.trimStart().startsWith("#");
}

function yamlMappingKeyPattern(key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `${escapedKey}[ \\t]*:`;
}

function usesOrdinaryMappingKeySyntax(line) {
  return /^[A-Za-z][A-Za-z0-9_-]*[ \t]*:/.test(line.trimStart());
}

/** Direct step blocks under a job's `steps:` sequence. */
function workflowStepBlocks(jobText) {
  const lines = jobText.split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^[ \t]*steps:[ \t]*(?:#.*)?$/.test(lines[i])) continue;
    const stepsIndent = indentation(lines[i]);
    let end = i + 1;
    while (end < lines.length) {
      const line = lines[end];
      if (
        line.trim() &&
        !isCommentOnlyLine(line) &&
        indentation(line) <= stepsIndent
      ) {
        break;
      }
      end += 1;
    }

    let itemIndent = null;
    const starts = [];
    for (let j = i + 1; j < end; j += 1) {
      const item = lines[j].match(/^([ \t]*)-[ \t]+/);
      if (!item) continue;
      const indent = indentation(lines[j]);
      if (itemIndent === null) itemIndent = indent;
      if (indent === itemIndent) starts.push(j);
    }
    for (let j = 0; j < starts.length; j += 1) {
      blocks.push({
        itemIndent,
        lines: lines.slice(starts[j], starts[j + 1] ?? end),
      });
    }
    i = end - 1;
  }
  return blocks;
}

function topLevelStepKey(block, key) {
  if (block.itemIndent === null) return null;
  const keyPattern = yamlMappingKeyPattern(key);
  const inline = block.lines[0]?.match(
    new RegExp(`^[ \\t]*-[ \\t]+${keyPattern}[ \\t]*(.*)$`),
  );
  if (inline) {
    return { index: 0, keyIndent: block.itemIndent + 2, value: inline[1] };
  }
  for (let i = 1; i < block.lines.length; i += 1) {
    if (indentation(block.lines[i]) !== block.itemIndent + 2) continue;
    const nested = block.lines[i].match(
      new RegExp(`^[ \\t]*${keyPattern}[ \\t]*(.*)$`),
    );
    if (nested) {
      return {
        index: i,
        keyIndent: block.itemIndent + 2,
        value: nested[1],
      };
    }
  }
  return null;
}

function stepUsesNonstandardMappingKeys(block) {
  if (block.itemIndent === null) return true;
  const inline = block.lines[0]?.replace(/^[ \t]*-[ \t]+/, "") ?? "";
  if (!usesOrdinaryMappingKeySyntax(inline)) return true;
  return block.lines
    .slice(1)
    .some(
      (line) =>
        line.trim() &&
        !isCommentOnlyLine(line) &&
        indentation(line) === block.itemIndent + 2 &&
        !usesOrdinaryMappingKeySyntax(line),
    );
}

function stepRunCommand(block) {
  const run = topLevelStepKey(block, "run");
  if (!run) return null;
  if (!/^[|>][+-]?[0-9]?$/.test(run.value.trim())) {
    return run.value.trim();
  }
  const commandLines = [];
  for (let i = run.index + 1; i < block.lines.length; i += 1) {
    const line = block.lines[i];
    if (
      line.trim() &&
      !isCommentOnlyLine(line) &&
      indentation(line) <= run.keyIndent
    ) {
      break;
    }
    commandLines.push(line.trim());
  }
  return commandLines.join("\n");
}

function stepMasksFailure(block) {
  const continueOnError = topLevelStepKey(block, "continue-on-error");
  return (
    continueOnError !== null &&
    !/^(?:false|['"]false['"])(?:\s+#.*)?$/.test(continueOnError.value.trim())
  );
}

function stepCanBypassRootGate(block) {
  return ["if", "shell", "working-directory"].some(
    (key) => topLevelStepKey(block, key) !== null,
  );
}

function commandRunsScriptWithoutMasking(command, scriptName) {
  const expected = `bun run ${scriptName}`;
  const commands = command
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter((line) => line && !line.startsWith("#"));
  return commands.length === 1 && commands[0] === expected;
}

/** Match an actual, failure-propagating workflow step for one exact root script. */
function hasBunRunStep(jobText, scriptName) {
  return workflowStepBlocks(jobText).some((block) => {
    const command = stepRunCommand(block);
    return (
      command !== null &&
      !stepMasksFailure(block) &&
      !stepCanBypassRootGate(block) &&
      !stepUsesNonstandardMappingKeys(block) &&
      commandRunsScriptWithoutMasking(command, scriptName)
    );
  });
}

function mappingHasTopLevelKey(text, key, mappingIndent) {
  const keyPattern = yamlMappingKeyPattern(key);
  return text
    .split(/\r?\n/)
    .some(
      (line) =>
        line.trim() &&
        !isCommentOnlyLine(line) &&
        indentation(line) === mappingIndent &&
        new RegExp(`^[ \\t]*${keyPattern}`).test(line),
    );
}

function mappingUsesNonstandardKeys(text, mappingIndent) {
  return text
    .split(/\r?\n/)
    .some(
      (line) =>
        line.trim() &&
        !isCommentOnlyLine(line) &&
        indentation(line) === mappingIndent &&
        !usesOrdinaryMappingKeySyntax(line),
    );
}

function jobHasTopLevelKey(jobText, key) {
  const lines = jobText
    .split(/\r?\n/)
    .filter((line) => line.trim() && !isCommentOnlyLine(line));
  if (lines.length === 0) return false;
  const jobIndent = Math.min(...lines.map(indentation));
  const keyPattern = yamlMappingKeyPattern(key);
  return lines.some(
    (line) =>
      indentation(line) === jobIndent &&
      new RegExp(`^[ \\t]*${keyPattern}`).test(line),
  );
}

function jobUsesNonstandardMappingKeys(jobText) {
  const lines = jobText
    .split(/\r?\n/)
    .filter((line) => line.trim() && !isCommentOnlyLine(line));
  if (lines.length === 0) return true;
  const jobIndent = Math.min(...lines.map(indentation));
  return mappingUsesNonstandardKeys(jobText, jobIndent);
}

function workflowHasTopLevelKey(text, key) {
  return mappingHasTopLevelKey(text, key, 0);
}

function workflowUsesNonstandardMappingKeys(text) {
  return mappingUsesNonstandardKeys(text, 0);
}

function jobCanBypassRequiredGate(jobText) {
  return ["if", "continue-on-error", "defaults", "needs", "strategy"].some(
    (key) => jobHasTopLevelKey(jobText, key),
  );
}

function jobMasksFailureOrOverridesRunDefaults(jobText) {
  return ["continue-on-error", "defaults"].some((key) =>
    jobHasTopLevelKey(jobText, key),
  );
}

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
    if (!isCommentOnlyLine(line) && /^ {2}\S/.test(line)) break; // next top-level job
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
    if (!isCommentOnlyLine(lines[i]) && /^ {2}\S/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join("\n");
}

function checkWorkflowText(fileName, text, problems) {
  if (
    (fileName === "test.yml" || fileName === DEVELOP_PR_WORKFLOW) &&
    (workflowHasTopLevelKey(text, "defaults") ||
      workflowUsesNonstandardMappingKeys(text))
  ) {
    problems.push(
      fileName +
        ": protected workflow must use ordinary root mapping keys and cannot set workflow-level run defaults",
    );
  }

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
      if (
        jobMasksFailureOrOverridesRunDefaults(gate) ||
        jobUsesNonstandardMappingKeys(gate)
      ) {
        problems.push(
          "test.yml: 'merge-quality-gate' must use ordinary mapping keys, retain its intended event gate, propagate failures, and keep root/default-shell run settings",
        );
      }
      const gateRunsOn = gate.match(/^\s+runs-on:\s*(.+?)\s*$/m)?.[1] ?? "";
      if (!hasHostedRunnerOrFleetFallback(gateRunsOn)) {
        problems.push(
          `test.yml: 'merge-quality-gate' runs-on is '${gateRunsOn || "missing"}', expected ubuntu-* or the ${FLEET_FALLBACK_VAR} hosted fallback expression`,
        );
      }
      const required = [
        {
          label: "read-only lint",
          present: hasBunRunStep(gate, "lint:check"),
        },
        {
          label: "format:check",
          present: hasBunRunStep(gate, "format:check"),
        },
        {
          label: "typecheck",
          present: hasBunRunStep(gate, "typecheck"),
        },
        {
          label: "stale-base guard",
          present: /stale-base-guard\.mjs[\s\S]*--merge-base/.test(gate),
        },
        {
          label: "gitleaks secret scan",
          present: /gitleaks detect\b/.test(gate),
        },
        {
          label: "merge-commit gitleaks patch scan",
          present: /--log-opts "-m -p -1 \$\{CURRENT_SHA\}"/.test(gate),
        },
      ];
      for (const { label, present } of required) {
        if (!present) {
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
      if (
        jobCanBypassRequiredGate(lintJob) ||
        jobUsesNonstandardMappingKeys(lintJob)
      ) {
        problems.push(
          `${fileName}: 'lint' job must use ordinary mapping keys, run unconditionally, propagate failures, and keep root/default-shell run settings`,
        );
      }
      if (!hasBunRunStep(lintJob, "lint:check")) {
        problems.push(`${fileName}: 'lint' job is missing bun run lint:check`);
      }
      if (!hasBunRunStep(lintJob, "format:check")) {
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
      - name: Read-only lint
        run: bun run lint:check
      - name: Format check
        run: bun run format:check
      - name: Typecheck
        run: bun run typecheck
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
      name: "gate missing read-only lint",
      text: good.replace("        run: bun run lint:check\n", ""),
    },
    {
      name: "gate lint near-miss script",
      text: good.replace("bun run lint:check", "bun run lint:check-fake"),
    },
    {
      name: "gate lint failure masked with or-true",
      text: good.replace("bun run lint:check", "bun run lint:check || true"),
    },
    {
      name: "gate lint failure masked after a successful chain member",
      text: good.replace(
        "bun run lint:check",
        "bun run lint:check && echo done || true",
      ),
    },
    {
      name: "gate lint failure masked after semicolon",
      text: good.replace("bun run lint:check", "bun run lint:check; true"),
    },
    {
      name: "gate lint script with a glued comment suffix",
      text: good.replace("bun run lint:check", "bun run lint:check#fake"),
    },
    {
      name: "gate lint command hidden in step env",
      text: good.replace(
        "        run: bun run lint:check",
        "        env:\n          run: bun run lint:check",
      ),
    },
    {
      name: "gate lint step allows failure",
      text: good.replace(
        "        run: bun run lint:check",
        "        continue-on-error: true\n        run: bun run lint:check",
      ),
    },
    {
      name: "gate lint step is conditional",
      text: good.replace(
        "        run: bun run lint:check",
        "        if: false\n        run: bun run lint:check",
      ),
    },
    {
      name: "gate lint condition follows a low-indented comment",
      text: good.replace(
        "        run: bun run lint:check",
        "        run: bun run lint:check\n# comment outside the step mapping\n        if: false",
      ),
    },
    {
      name: "gate lint condition uses whitespace before the colon",
      text: good.replace(
        "        run: bun run lint:check",
        "        if : false\n        run: bun run lint:check",
      ),
    },
    {
      name: "gate lint condition uses a quoted YAML key",
      text: good.replace(
        "        run: bun run lint:check",
        '        "if" : false\n        run: bun run lint:check',
      ),
    },
    {
      name: "gate lint condition uses explicit YAML key syntax",
      text: good.replace(
        "        run: bun run lint:check",
        "        ? if\n        : false\n        run: bun run lint:check",
      ),
    },
    {
      name: "gate lint condition uses a tagged YAML key",
      text: good.replace(
        "        run: bun run lint:check",
        "        !!str if: false\n        run: bun run lint:check",
      ),
    },
    {
      name: "gate lint condition uses an anchored YAML key",
      text: good.replace(
        "        run: bun run lint:check",
        "        &condition if: false\n        run: bun run lint:check",
      ),
    },
    {
      name: "gate lint step changes working directory",
      text: good.replace(
        "        run: bun run lint:check",
        "        working-directory: packages/core\n        run: bun run lint:check",
      ),
    },
    {
      name: "gate lint step overrides the shell",
      text: good.replace(
        "        run: bun run lint:check",
        "        shell: bash -c '{0}; true'\n        run: bun run lint:check",
      ),
    },
    {
      name: "gate folded lint command masks failure",
      text: good.replace(
        "        run: bun run lint:check",
        "        run: >\n          bun run lint:check\n          || true",
      ),
    },
    {
      name: "gate job allows failure",
      text: good.replace(
        "  merge-quality-gate:\n",
        "  merge-quality-gate:\n    continue-on-error: true\n",
      ),
    },
    {
      name: "gate job changes run defaults",
      text: good.replace(
        "  merge-quality-gate:\n",
        "  merge-quality-gate:\n    defaults:\n      run:\n        working-directory: packages/core\n",
      ),
    },
    {
      name: "gate workflow changes run defaults",
      text: good.replace(
        "jobs:\n",
        "defaults:\n  run:\n    working-directory: packages/core\njobs:\n",
      ),
    },
    {
      name: "gate missing format check",
      text: good.replace("        run: bun run format:check\n", ""),
    },
    {
      name: "gate missing typecheck",
      text: good.replace("        run: bun run typecheck\n", ""),
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
      - name: Read-only lint
        run: bun run lint:check
      - name: Format check
        run: bun run format:check
`;
  const developProblems = [];
  checkWorkflowText(DEVELOP_PR_WORKFLOW, goodDevelopPr, developProblems);
  if (developProblems.length !== 0) {
    throw new Error(
      `self-test: valid develop PR fixture reported problems:\n  ${developProblems.join("\n  ")}`,
    );
  }
  for (const command of ["bun run lint:check", "bun run format:check"]) {
    const problems = [];
    checkWorkflowText(
      DEVELOP_PR_WORKFLOW,
      goodDevelopPr.replace(`        run: ${command}\n`, ""),
      problems,
    );
    if (problems.length === 0) {
      throw new Error(
        `self-test: develop PR fixture missing '${command}' was not caught`,
      );
    }
  }
  const conditionalDevelopProblems = [];
  checkWorkflowText(
    DEVELOP_PR_WORKFLOW,
    goodDevelopPr.replace(
      "    runs-on: ubuntu-latest",
      "    if: false\n    runs-on: ubuntu-latest",
    ),
    conditionalDevelopProblems,
  );
  if (conditionalDevelopProblems.length === 0) {
    throw new Error(
      "self-test: conditional develop PR lint job was not caught",
    );
  }
  const commentedConditionalDevelopProblems = [];
  checkWorkflowText(
    DEVELOP_PR_WORKFLOW,
    goodDevelopPr.replace(
      "        run: bun run format:check",
      "        run: bun run format:check\n  # comment outside the job mapping\n    if: false",
    ),
    commentedConditionalDevelopProblems,
  );
  if (commentedConditionalDevelopProblems.length === 0) {
    throw new Error(
      "self-test: develop PR lint condition after a low-indented comment was not caught",
    );
  }
  const spacedConditionalDevelopProblems = [];
  checkWorkflowText(
    DEVELOP_PR_WORKFLOW,
    goodDevelopPr.replace(
      "    runs-on: ubuntu-latest",
      "    if : false\n    runs-on: ubuntu-latest",
    ),
    spacedConditionalDevelopProblems,
  );
  if (spacedConditionalDevelopProblems.length === 0) {
    throw new Error(
      "self-test: develop PR lint condition with whitespace before its colon was not caught",
    );
  }
  const quotedConditionalDevelopProblems = [];
  checkWorkflowText(
    DEVELOP_PR_WORKFLOW,
    goodDevelopPr.replace(
      "    runs-on: ubuntu-latest",
      "    'if' : false\n    runs-on: ubuntu-latest",
    ),
    quotedConditionalDevelopProblems,
  );
  if (quotedConditionalDevelopProblems.length === 0) {
    throw new Error(
      "self-test: develop PR lint condition with a quoted YAML key was not caught",
    );
  }
  const explicitConditionalDevelopProblems = [];
  checkWorkflowText(
    DEVELOP_PR_WORKFLOW,
    goodDevelopPr.replace(
      "    runs-on: ubuntu-latest",
      "    ? if\n    : false\n    runs-on: ubuntu-latest",
    ),
    explicitConditionalDevelopProblems,
  );
  if (explicitConditionalDevelopProblems.length === 0) {
    throw new Error(
      "self-test: develop PR lint condition with explicit YAML key syntax was not caught",
    );
  }
  const bypassingDevelopFixtures = [
    {
      name: "job-level dependency",
      text: goodDevelopPr.replace(
        "    runs-on: ubuntu-latest",
        "    needs: never-runs\n    runs-on: ubuntu-latest",
      ),
    },
    {
      name: "job-level matrix strategy",
      text: goodDevelopPr.replace(
        "    runs-on: ubuntu-latest",
        "    strategy:\n      matrix:\n        shard: []\n    runs-on: ubuntu-latest",
      ),
    },
    {
      name: "job-level continue-on-error",
      text: goodDevelopPr.replace(
        "    runs-on: ubuntu-latest",
        "    continue-on-error: true\n    runs-on: ubuntu-latest",
      ),
    },
    {
      name: "job-level run defaults",
      text: goodDevelopPr.replace(
        "    runs-on: ubuntu-latest",
        "    defaults:\n      run:\n        working-directory: packages/core\n    runs-on: ubuntu-latest",
      ),
    },
    {
      name: "workflow-level run defaults",
      text: goodDevelopPr.replace(
        "jobs:\n",
        "defaults:\n  run:\n    shell: bash -c '{0}; true'\njobs:\n",
      ),
    },
  ];
  for (const { name, text } of bypassingDevelopFixtures) {
    const problems = [];
    checkWorkflowText(DEVELOP_PR_WORKFLOW, text, problems);
    if (problems.length === 0) {
      throw new Error(
        `self-test: develop PR fixture with ${name} was not caught`,
      );
    }
  }
  console.log(
    `ci-merge-gate-contract self-test: ${badCases.length + 14} cases passed`,
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
