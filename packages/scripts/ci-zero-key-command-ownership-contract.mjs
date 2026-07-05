#!/usr/bin/env node
/**
 * Contract for #13402's zero-key command ownership slice. The keyless and
 * zero-key workflows may share setup, but each real test/suite command must
 * have exactly one owner so PRs do not execute the same suite in multiple
 * workflows by accident.
 *
 * This is a static YAML census: it does not run workflows. It scans only the
 * zero-key/keyless workflow surface listed below, extracts shell commands from
 * zero-key job blocks, normalizes them, and fails when the same non-setup
 * command appears more than once.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const OWNED_WORKFLOWS = [
  { file: ".github/workflows/test.yml", owner: "test-orchestrator" },
  { file: ".github/workflows/scenario-pr.yml", owner: "scenario-pr-zero-key" },
  {
    file: ".github/workflows/keyless-harness-e2e.yml",
    owner: "keyless-harness",
    includeAllJobs: true,
  },
  {
    file: ".github/workflows/ui-fixture-e2e.yml",
    owner: "ui-fixture-e2e",
    includeAllJobs: true,
  },
];

const ZERO_KEY_MARKER =
  /Zero-Key|zero-key|keyless|secret-free|no secret|SCENARIO_USE_LLM_PROXY|ELIZA_LIVE_TEST:\s*["']?0/i;

const COMMAND_PREFIX = /^(bun|bunx|node|npm|pnpm|bash|cargo|python3?)\b/;
const IGNORED_LINE =
  /^(set |if |then$|else$|elif |fi$|for |do$|done$|while |case |esac$|echo |cat |sleep |exit |trap |cd |mkdir |rm |cp |mv |sudo |export |[{}]$)/;
const LEADING_ENV_ASSIGNMENT =
  /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)\s*/;

const STATIC_DELEGATION_JOBS = new Set([
  ".github/workflows/test.yml#changes",
  ".github/workflows/scenario-pr.yml#changes",
  ".github/workflows/scenario-pr.yml#app-diagnostics",
]);

const ALLOWED_DUPLICATE_COMMANDS = new Set([
  "node packages/app-core/scripts/ensure-shared-i18n-data.mjs",
  "bunx playwright install --with-deps chromium",
  "node packages/scripts/ci-zero-key-command-ownership-contract.mjs",
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function countIndent(line) {
  return line.match(/^ */)?.[0].length ?? 0;
}

function stripInlineComment(line) {
  return line.replace(/\s+#.*$/, "").trim();
}

function stripLeadingEnvAssignments(line) {
  let command = line.trim();
  if (command.startsWith("env ")) {
    command = command.slice(4).trimStart();
  }
  for (;;) {
    const next = command.replace(LEADING_ENV_ASSIGNMENT, "").trimStart();
    if (next === command) return command;
    command = next;
  }
}

function normalizeCommand(line) {
  return stripLeadingEnvAssignments(stripInlineComment(line))
    .replace(/\s+/g, " ")
    .trim();
}

function extractJobBlocks(workflowText) {
  const jobsIndex = workflowText.search(/^jobs:\s*$/m);
  if (jobsIndex < 0) return [];
  const lines = workflowText.slice(jobsIndex).split(/\r?\n/);
  const starts = [];
  for (let i = 1; i < lines.length; i += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) starts.push(i);
  }
  const blocks = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const end = starts[i + 1] ?? lines.length;
    const key = lines[start].trim().slice(0, -1);
    blocks.push({ key, text: lines.slice(start, end).join("\n") });
  }
  return blocks;
}

function extractRunBodies(jobText) {
  const lines = jobText.split(/\r?\n/);
  const bodies = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^(\s*)run:\s*(.*)$/);
    if (!match) continue;
    const indent = match[1].length;
    const rest = match[2].trim();
    if (rest && !/^[>|]/.test(rest)) {
      bodies.push(rest);
      continue;
    }
    const bodyLines = [];
    for (i += 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim() !== "" && countIndent(line) <= indent) {
        i -= 1;
        break;
      }
      bodyLines.push(line.slice(Math.min(line.length, indent + 2)));
    }
    bodies.push(bodyLines.join("\n"));
  }
  return bodies;
}

function extractCommands(jobText) {
  const commands = [];
  for (const body of extractRunBodies(jobText)) {
    for (const rawLine of body.split(/\r?\n/)) {
      const command = normalizeCommand(rawLine);
      if (!command || command.startsWith("#")) continue;
      if (IGNORED_LINE.test(command)) continue;
      if (!COMMAND_PREFIX.test(command)) continue;
      commands.push(command);
    }
  }
  return commands;
}

export function collectZeroKeyCommands(repoRoot = DEFAULT_REPO_ROOT) {
  const rows = [];
  for (const workflow of OWNED_WORKFLOWS) {
    const text = readFileSync(resolve(repoRoot, workflow.file), "utf8");
    for (const job of extractJobBlocks(text)) {
      if (STATIC_DELEGATION_JOBS.has(`${workflow.file}#${job.key}`)) continue;
      const includeJob =
        workflow.includeAllJobs || ZERO_KEY_MARKER.test(job.text);
      if (!includeJob) continue;
      for (const command of extractCommands(job.text)) {
        rows.push({
          workflow: workflow.file,
          owner: workflow.owner,
          job: job.key,
          command,
        });
      }
    }
  }
  return rows;
}

export function findDuplicateOwnedCommands(rows) {
  const byCommand = new Map();
  for (const row of rows) {
    if (ALLOWED_DUPLICATE_COMMANDS.has(row.command)) continue;
    const existing = byCommand.get(row.command) ?? [];
    existing.push(row);
    byCommand.set(row.command, existing);
  }
  return [...byCommand.entries()]
    .filter(([, locations]) => locations.length > 1)
    .map(([command, locations]) => ({ command, locations }));
}

export function runContract(repoRoot = DEFAULT_REPO_ROOT) {
  const rows = collectZeroKeyCommands(repoRoot);
  assert(
    rows.length > 0,
    "zero-key command ownership census found no commands",
  );
  const duplicates = findDuplicateOwnedCommands(rows);
  assert(
    duplicates.length === 0,
    "Duplicate zero-key command ownership found:\n" +
      duplicates
        .map(
          ({ command, locations }) =>
            `- ${command}\n` +
            locations
              .map(
                ({ workflow, job, owner }) =>
                  `  - ${workflow}#${job} (${owner})`,
              )
              .join("\n"),
        )
        .join("\n"),
  );
  return {
    commandCount: rows.length,
    workflows: OWNED_WORKFLOWS.map((workflow) => workflow.file),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { commandCount, workflows } = runContract();
    console.log(
      `ci zero-key command ownership contract passed (${commandCount} command(s), ${workflows.length} workflow(s) scanned)`,
    );
  } catch (error) {
    console.error(
      `[ci-zero-key-command-ownership-contract] FAIL ${error.message}`,
    );
    process.exit(1);
  }
}
