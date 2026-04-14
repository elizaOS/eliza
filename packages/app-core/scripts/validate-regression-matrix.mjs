import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_CORE_ROOT = path.resolve(SCRIPT_DIR, "..");

function findRepoRoot(startDir) {
  let currentDir = startDir;
  let matchedRoot = null;
  while (true) {
    if (
      fs.existsSync(path.join(currentDir, "package.json")) &&
      fs.existsSync(path.join(currentDir, ".github", "workflows"))
    ) {
      matchedRoot = currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      if (matchedRoot) {
        return matchedRoot;
      }
      throw new Error(`Unable to resolve repository root from ${startDir}.`);
    }

    currentDir = parentDir;
  }
}

const REPO_ROOT = findRepoRoot(APP_CORE_ROOT);
const MANIFEST_PATH = path.join(
  APP_CORE_ROOT,
  "test",
  "regression-matrix.json",
);
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args.set(token.slice(2), true);
      continue;
    }
    args.set(token.slice(2), next);
    index += 1;
  }
  return args;
}

function normalisePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL placeholder for glob ** conversion
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesAnyGlob(filePath, globs) {
  const normalisedPath = normalisePath(filePath);
  return globs.some((glob) => globToRegExp(glob).test(normalisedPath));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function expandScheduledSuites(suiteIds) {
  const expanded = new Set(suiteIds);
  for (const suiteId of suiteIds) {
    const providedSuites = manifest.suites[suiteId]?.provides ?? [];
    for (const provided of providedSuites) {
      expanded.add(provided);
    }
  }
  return expanded;
}

function collectChangedFiles(args) {
  const base =
    args.get("base") ??
    process.env.GITHUB_BASE_SHA ??
    (process.env.GITHUB_BASE_REF
      ? `origin/${process.env.GITHUB_BASE_REF}`
      : null);
  const head = args.get("head") ?? process.env.GITHUB_SHA ?? "HEAD";

  if (!base) {
    return [];
  }

  const commands = [
    ["diff", "--name-only", `${base}...${head}`],
    ["diff", "--name-only", base, head],
  ];

  for (const command of commands) {
    try {
      const raw = execFileSync("git", command, {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map(normalisePath);
    } catch {
      // Try the next diff strategy.
    }
  }

  throw new Error(
    `Unable to resolve changed files from base "${base}" to head "${head}".`,
  );
}

function ensureWorkflowContracts(workflowName, failures) {
  const workflowContract = manifest.workflowContracts[workflowName];
  const workflowTexts = workflowContract.files.map((relativePath) => ({
    relativePath,
    text: readText(relativePath),
  }));

  for (const suiteId of workflowContract.scheduledSuites) {
    const suite = manifest.suites[suiteId];
    if (!suite) {
      failures.push(
        `Workflow "${workflowName}" references unknown suite "${suiteId}".`,
      );
      continue;
    }

    if (suite.command) {
      const present = workflowTexts.some(({ text }) =>
        text.includes(suite.command),
      );
      if (!present) {
        failures.push(
          `Workflow "${workflowName}" does not schedule "${suiteId}" via "${suite.command}".`,
        );
      }
    }

    if (suite.workflowCall) {
      const present = workflowTexts.some(({ text }) =>
        text.includes(suite.workflowCall),
      );
      if (!present) {
        failures.push(
          `Workflow "${workflowName}" does not reference "${suite.workflowCall}" for suite "${suiteId}".`,
        );
      }
    }

    for (const snippet of suite.requiredSnippets ?? []) {
      const present = workflowTexts.some(({ text }) => text.includes(snippet));
      if (!present) {
        failures.push(
          `Workflow "${workflowName}" is missing required snippet for "${suiteId}": ${snippet}`,
        );
      }
    }
  }

  for (const snippet of workflowContract.bannedSnippets ?? []) {
    const present = workflowTexts.some(({ text }) => text.includes(snippet));
    if (present) {
      failures.push(
        `Workflow "${workflowName}" still contains banned inline snippet: ${snippet}`,
      );
    }
  }

  return expandScheduledSuites(workflowContract.scheduledSuites);
}

function ensurePackageScripts(failures) {
  const packageJson = JSON.parse(readText("package.json"));
  const scripts = packageJson.scripts ?? {};

  for (const [scriptName, disallowedSnippets] of Object.entries(
    manifest.guards.packageScriptDisallowlist ?? {},
  )) {
    const scriptBody = scripts[scriptName] ?? "";
    for (const snippet of disallowedSnippets) {
      if (scriptBody.includes(snippet)) {
        failures.push(
          `package.json script "${scriptName}" still contains stale snippet: ${snippet}`,
        );
      }
    }
  }

  const deterministicE2E = scripts["test:e2e"] ?? "";
  const heavyE2E = scripts["test:e2e:heavy"] ?? "";
  for (const exception of manifest.exceptions.heavyOnlyE2E ?? []) {
    if (!deterministicE2E.includes(`--exclude ${exception.path}`)) {
      failures.push(
        `test:e2e must explicitly exclude heavy-only path ${exception.path}.`,
      );
    }
    if (!heavyE2E.includes(exception.path)) {
      failures.push(
        `test:e2e:heavy must explicitly include heavy-only path ${exception.path}.`,
      );
    }
  }
}

function ensureDesktopInventory(failures) {
  const checklistPath = path.join(REPO_ROOT, manifest.manualChecklistDoc);
  if (!fs.existsSync(checklistPath)) {
    failures.push(
      `Manual desktop checklist is missing: ${manifest.manualChecklistDoc}`,
    );
    return;
  }

  const checklistText = fs.readFileSync(checklistPath, "utf8");
  const inventoryTexts = (manifest.guards.desktopInventorySources ?? []).map(
    (relativePath) => ({
      relativePath,
      text: readText(relativePath),
    }),
  );

  const items = [
    ...(manifest.exceptions.desktopHeavyInventory ?? []),
    ...(manifest.exceptions.desktopManualChecklist ?? []),
  ];

  const seenIds = new Set();
  for (const item of items) {
    if (seenIds.has(item.id)) {
      failures.push(
        `Desktop regression inventory item id is duplicated: ${item.id}`,
      );
      continue;
    }
    seenIds.add(item.id);

    const presentInInventory = inventoryTexts.some(({ text }) =>
      text.includes(item.description),
    );
    if (!presentInInventory) {
      failures.push(
        `Desktop regression inventory source does not reference "${item.description}".`,
      );
    }
  }

  for (const item of manifest.exceptions.desktopManualChecklist ?? []) {
    if (!checklistText.includes(item.description)) {
      failures.push(
        `Manual desktop checklist is missing "${item.description}".`,
      );
    }
  }

  for (const { relativePath, text } of inventoryTexts) {
    for (const marker of manifest.guards.forbiddenDesktopInventoryMarkers ??
      []) {
      if (text.includes(marker)) {
        failures.push(
          `${relativePath} still contains forbidden desktop inventory marker "${marker}".`,
        );
      }
    }
  }
}

function ensureChangedFileCoverage(
  workflowName,
  scheduledSuites,
  failures,
  args,
) {
  const changedFiles = collectChangedFiles(args);
  if (changedFiles.length === 0) {
    console.log(
      `No changed-file diff available for workflow "${workflowName}". Static contract checks only.`,
    );
    return;
  }

  const requiredSuites = new Set();
  const matchedSurfaces = [];

  for (const filePath of changedFiles) {
    for (const surface of manifest.surfaces) {
      if (!matchesAnyGlob(filePath, surface.globs)) continue;
      matchedSurfaces.push(`${filePath} -> ${surface.name}`);
      for (const suiteId of surface.workflowSuites?.[workflowName] ?? []) {
        requiredSuites.add(suiteId);
      }
    }
  }

  if (matchedSurfaces.length > 0) {
    console.log(`Matched regression surfaces for "${workflowName}":`);
    for (const entry of matchedSurfaces) {
      console.log(`- ${entry}`);
    }
  }

  for (const suiteId of requiredSuites) {
    if (!scheduledSuites.has(suiteId)) {
      failures.push(
        `Changed files require suite "${suiteId}" for workflow "${workflowName}", but that suite is not scheduled.`,
      );
    }
  }
}

const args = parseArgs(process.argv.slice(2));
const workflowName = args.get("workflow");

if (
  typeof workflowName !== "string" ||
  !manifest.workflowContracts[workflowName]
) {
  console.error(
    `Usage: node scripts/validate-regression-matrix.mjs --workflow <${Object.keys(
      manifest.workflowContracts,
    ).join("|")}> [--base <git-ref>] [--head <git-ref>]`,
  );
  process.exit(1);
}

const failures = [];
const scheduledSuites = ensureWorkflowContracts(workflowName, failures);
ensurePackageScripts(failures);
ensureDesktopInventory(failures);
ensureChangedFileCoverage(workflowName, scheduledSuites, failures, args);

if (failures.length > 0) {
  console.error("\nRegression matrix validation failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(
  `Regression matrix validation passed for workflow "${workflowName}".`,
);
