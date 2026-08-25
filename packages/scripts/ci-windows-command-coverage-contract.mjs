#!/usr/bin/env node
/**
 * Contract for #13402's Windows command-coverage slice. The Windows lane is
 * a deliberately narrow subset of the Linux gates, so the
 * suites it guards are the only proof that the runtime/dashboard/shared
 * TypeScript packages still build and pass on Windows. Nothing else re-runs
 * them there. That makes silent shrinkage the failure mode: a lane trimmed
 * "to speed CI up", a plugin quietly dropped from the `plugins` lane, or a
 * whole matrix entry removed in a refactor, and Windows coverage regresses
 * with a still-green pipeline and no reviewer signal.
 *
 * This is a static YAML census — it never executes a workflow. It parses the
 * `run:` steps of `jobs.platform-smoke` in `.github/workflows/platform-smoke.yml`
 * (whose matrix includes windows-2025), flattens them into a set, and asserts
 * every command in the committed inventory `.github/ci-windows-command-inventory.json`
 * is still wired there. If any inventoried command is missing, Windows
 * coverage shrank: the contract throws (exit 1) naming the dropped commands.
 *
 * Adding a command is always allowed — the inventory is a floor, not an exact
 * match. To intentionally retire a Windows command, delete it from the matrix
 * AND from the inventory in the same PR; the contract then passes because the
 * floor moved with it, and the diff makes the coverage reduction reviewable.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const WORKFLOW_FILE = ".github/workflows/platform-smoke.yml";
const INVENTORY_FILE = ".github/ci-windows-command-inventory.json";
const JOB_KEY = "platform-smoke";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function indentOf(line) {
  return line.match(/^ */)?.[0].length ?? 0;
}

// Slice the lines of a single top-level job block (`  <key>:`) out of the
// `jobs:` section. Job keys are the only 2-space-indented map keys under
// `jobs:`, so the block runs from that header until the next 2-space key.
function jobBlockLines(workflowText, jobKey) {
  const lines = workflowText.split(/\r?\n/);
  const jobsIndex = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  assert(jobsIndex >= 0, `${WORKFLOW_FILE}: no top-level "jobs:" mapping`);

  let start = -1;
  for (let i = jobsIndex + 1; i < lines.length; i += 1) {
    if (new RegExp(`^ {2}${jobKey}:\\s*$`).test(lines[i])) {
      start = i;
      break;
    }
  }
  assert(start >= 0, `${WORKFLOW_FILE}: no "${jobKey}" job under "jobs:"`);

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() !== "" && /^ {2}\S/.test(line)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end);
}

// Collect every single-line `run:` command from the job's steps. The
// platform-smoke matrix includes windows-2025, so each run step here is
// executed on Windows; the job must also keep windows in its matrix or the
// coverage claim is hollow.
export function parseWindowsCommands(repoRoot = DEFAULT_REPO_ROOT) {
  const text = readFileSync(resolve(repoRoot, WORKFLOW_FILE), "utf8");
  const lines = jobBlockLines(text, JOB_KEY);

  assert(
    lines.some((line) => /\bwindows-\d+\b/.test(line)),
    `${WORKFLOW_FILE}: "${JOB_KEY}" no longer includes a windows matrix entry - Windows coverage is gone`,
  );

  const commands = [];
  for (const line of lines) {
    const match = line.match(/^\s*run:\s+(.+?)\s*$/);
    if (match) commands.push(match[1]);
  }

  assert(
    commands.length > 0,
    `${WORKFLOW_FILE}: parsed no run commands from "${JOB_KEY}" steps`,
  );
  return commands;
}

export function loadInventory(repoRoot = DEFAULT_REPO_ROOT) {
  const manifest = JSON.parse(
    readFileSync(resolve(repoRoot, INVENTORY_FILE), "utf8"),
  );
  const inventory = manifest.commands;
  assert(
    Array.isArray(inventory) && inventory.every((c) => typeof c === "string"),
    `${INVENTORY_FILE}: "commands" must be a string array`,
  );
  assert(
    inventory.length > 0,
    `${INVENTORY_FILE}: "commands" must not be empty`,
  );
  return inventory;
}

// Inventoried commands no longer wired in any Windows lane. A non-empty result
// means coverage shrank without the inventory being updated to match.
export function findDroppedCommands(inventory, present) {
  const wired = new Set(present);
  return inventory.filter((command) => !wired.has(command));
}

export function runContract(repoRoot = DEFAULT_REPO_ROOT) {
  const present = parseWindowsCommands(repoRoot);
  const inventory = loadInventory(repoRoot);
  const dropped = findDroppedCommands(inventory, present);

  assert(
    dropped.length === 0,
    `Windows CI command coverage shrank. These inventoried commands are no longer wired in any ` +
      `${WORKFLOW_FILE} lane:\n` +
      dropped.map((command) => `  - ${command}`).join("\n") +
      `\n\nRestore them, or — if the reduction is intentional — remove them from ${INVENTORY_FILE} ` +
      `in the same PR so the coverage floor moves with the matrix.`,
  );

  return { commandCount: present.length, inventoryCount: inventory.length };
}

if (import.meta.main) {
  try {
    const { commandCount, inventoryCount } = runContract();
    console.log(
      `ci windows command coverage contract passed ` +
        `(${commandCount} lane command(s); ${inventoryCount} inventoried command(s) all present)`,
    );
  } catch (error) {
    console.error(
      `[ci-windows-command-coverage-contract] FAIL ${error.message}`,
    );
    process.exit(1);
  }
}
