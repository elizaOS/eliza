/**
 * Validates regression-matrix.json against the repo: every suite's guard
 * snippets must appear in the referenced GitHub workflow files and the manual
 * desktop checklist doc must contain its items, so the matrix cannot silently
 * drift from CI.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_CORE_ROOT = path.resolve(SCRIPT_DIR, "..");

function explicitRepoRoot() {
  const raw = process.env.ELIZA_REGRESSION_MATRIX_REPO_ROOT;
  const explicitRoot = raw?.trim();
  if (!explicitRoot) return null;

  const repoRoot = path.resolve(explicitRoot);
  if (
    fs.existsSync(path.join(repoRoot, "package.json")) &&
    fs.existsSync(path.join(repoRoot, ".github", "workflows"))
  ) {
    return repoRoot;
  }

  throw new Error(
    `Explicit regression matrix repository root is invalid: ${repoRoot}`,
  );
}

function findRepoRoot(startDir) {
  const configuredRoot = explicitRepoRoot();
  if (configuredRoot) return configuredRoot;

  try {
    return execFileSync(
      "git",
      ["-C", startDir, "rev-parse", "--show-toplevel"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
  } catch {
    // Fall back to the legacy package/workflow sentinel walk for non-git exports.
  }

  let currentDir = startDir;
  while (true) {
    if (
      fs.existsSync(path.join(currentDir, "package.json")) &&
      fs.existsSync(path.join(currentDir, ".github", "workflows"))
    ) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
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

function normalizeGuardMarker(marker) {
  if (typeof marker === "string") return marker;
  if (
    Array.isArray(marker) &&
    marker.every((part) => typeof part === "string")
  ) {
    return marker.join("");
  }
  throw new Error(
    `Regression matrix guard marker must be a string or string-part array: ${JSON.stringify(marker)}`,
  );
}

function parsePathAliases(raw) {
  if (!raw?.trim()) return [];

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separatorIndex = entry.indexOf("=");
      if (separatorIndex <= 0 || separatorIndex === entry.length - 1) {
        throw new Error(
          `Invalid regression matrix path alias "${entry}". Expected from=to.`,
        );
      }

      return {
        from: normalisePath(entry.slice(0, separatorIndex)),
        to: normalisePath(entry.slice(separatorIndex + 1)),
      };
    });
}

const REPO_PATH_ALIASES = parsePathAliases(
  process.env.ELIZA_REGRESSION_MATRIX_PATH_ALIASES ??
    (process.env.ELIZA_REGRESSION_MATRIX_REPO_ROOT
      ? "packages/docs/=docs/"
      : ""),
);

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

function resolveRepoRelativePath(relativePath) {
  const normalisedPath = normalisePath(relativePath);
  const directPath = path.join(REPO_ROOT, normalisedPath);
  if (fs.existsSync(directPath)) return normalisedPath;

  for (const alias of REPO_PATH_ALIASES) {
    if (!normalisedPath.startsWith(alias.from)) continue;

    const aliasedPath = `${alias.to}${normalisedPath.slice(alias.from.length)}`;
    if (fs.existsSync(path.join(REPO_ROOT, aliasedPath))) {
      return aliasedPath;
    }
  }

  const nestedElizaPath = path.join("eliza", normalisedPath);
  if (fs.existsSync(path.join(REPO_ROOT, nestedElizaPath))) {
    return nestedElizaPath;
  }

  return normalisedPath;
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

function resolveScriptWorkingDir(scriptBody) {
  const match = scriptBody.match(/^cd\s+(\S+)\s*&&/);
  return match ? match[1] : ".";
}

function resolveConfigFlagPath(scriptBody) {
  const match = scriptBody.match(/--config[= ]("?)([^"\s]+)\1/);
  return match ? match[2] : null;
}

/**
 * Best-effort static extraction of a top-level `name: [ "a", "b" ]` string
 * array from a Vitest config source file. Not a full parser — sufficient for
 * the literal, non-computed `include`/`exclude` arrays these configs use.
 * Returns `null` when the array cannot be found at all, distinct from `[]`
 * for an array that parses empty.
 */
function extractConfigStringArray(configSource, arrayName) {
  const arrayPattern = new RegExp(`\\b${arrayName}\\s*:\\s*\\[([^\\]]*)\\]`);
  const match = configSource.match(arrayPattern);
  if (!match) return null;
  return Array.from(
    match[1].matchAll(/["'`]([^"'`]+)["'`]/g),
    (entry) => entry[1],
  );
}

/**
 * `vitest run --config <file> <path>` treats trailing path arguments as
 * filters over the config's own `include` set — they narrow an
 * already-matched file list, they never add to it. A heavy-only path can
 * appear verbatim in test:e2e:heavy's script string and still match zero
 * files if the referenced config's `include` globs do not independently
 * reach it, with `--passWithNoTests` (or a bare zero-file exit) masking the
 * result as green. Resolve the config test:e2e:heavy actually runs against
 * and require every heavy-only exception path to be a real file its
 * `include`/`exclude` globs would discover.
 */
function ensureHeavyOnlyE2EReachability(heavyE2EScript, failures) {
  const exceptions = manifest.exceptions.heavyOnlyE2E ?? [];
  if (exceptions.length === 0) return;

  const configFlagPath = resolveConfigFlagPath(heavyE2EScript);
  if (!configFlagPath) {
    failures.push(
      "test:e2e:heavy does not pass a --config flag; cannot verify heavy-only path reachability.",
    );
    return;
  }

  const scriptWorkingDir = resolveScriptWorkingDir(heavyE2EScript);
  const configRepoPath = normalisePath(
    path.join(scriptWorkingDir, configFlagPath),
  );
  const configAbsolutePath = path.join(REPO_ROOT, configRepoPath);
  if (!fs.existsSync(configAbsolutePath)) {
    failures.push(
      `test:e2e:heavy references --config "${configRepoPath}", which does not exist.`,
    );
    return;
  }

  const configSource = readText(configRepoPath);
  const includeGlobs = extractConfigStringArray(configSource, "include");
  const excludeGlobs = extractConfigStringArray(configSource, "exclude") ?? [];
  if (!includeGlobs || includeGlobs.length === 0) {
    failures.push(
      `Unable to statically extract a non-empty "include" array from ${configRepoPath}; cannot verify heavy-only path reachability.`,
    );
    return;
  }

  const configDir = normalisePath(path.dirname(configRepoPath));
  const reachableFiles = new Set(
    fs
      .globSync(includeGlobs, {
        cwd: path.dirname(configAbsolutePath),
        dot: true,
      })
      .map(normalisePath)
      .filter((candidate) => !matchesAnyGlob(candidate, excludeGlobs)),
  );

  for (const exception of exceptions) {
    const exceptionRepoPath = normalisePath(exception.path);
    const pathRelativeToConfig =
      configDir !== "." && exceptionRepoPath.startsWith(`${configDir}/`)
        ? exceptionRepoPath.slice(configDir.length + 1)
        : exceptionRepoPath;

    if (!reachableFiles.has(pathRelativeToConfig)) {
      failures.push(
        `Heavy-only path "${exception.path}" is not reachable through test:e2e:heavy's config ` +
          `"${configRepoPath}" (looked for "${pathRelativeToConfig}" relative to that config's root; ` +
          `its include globs are: ${includeGlobs.join(", ")}). vitest CLI file arguments only narrow an ` +
          "already-discovered set, so this path would silently match zero files even though it appears " +
          "verbatim in the script string.",
      );
    }
  }
}

function readText(relativePath) {
  return fs.readFileSync(
    path.join(REPO_ROOT, resolveRepoRelativePath(relativePath)),
    "utf8",
  );
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
  // test:e2e:heavy may `cd` into a package directory before invoking vitest
  // (see ensureHeavyOnlyE2EReachability below), so the heavy-only path it
  // names on the command line is relative to that directory, not repo root.
  const heavyE2EWorkingDir = resolveScriptWorkingDir(heavyE2E);
  for (const exception of manifest.exceptions.heavyOnlyE2E ?? []) {
    if (!deterministicE2E.includes(`--exclude ${exception.path}`)) {
      failures.push(
        `test:e2e must explicitly exclude heavy-only path ${exception.path}.`,
      );
    }
    const heavyPathVariant =
      heavyE2EWorkingDir !== "." &&
      exception.path.startsWith(`${heavyE2EWorkingDir}/`)
        ? exception.path.slice(heavyE2EWorkingDir.length + 1)
        : exception.path;
    if (!heavyE2E.includes(heavyPathVariant)) {
      failures.push(
        `test:e2e:heavy must explicitly include heavy-only path ${exception.path}.`,
      );
    }
  }

  ensureHeavyOnlyE2EReachability(heavyE2E, failures);
}

function ensureDesktopInventory(failures) {
  const checklistPath = path.join(
    REPO_ROOT,
    resolveRepoRelativePath(manifest.manualChecklistDoc),
  );
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
    for (const rawMarker of manifest.guards.forbiddenDesktopInventoryMarkers ??
      []) {
      const marker = normalizeGuardMarker(rawMarker);
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
