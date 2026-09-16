#!/usr/bin/env node
/**
 * Reports static command references for root commands, app commands and top-level
 * repository MJS tools. This deliberately partial inventory is advisory: textual
 * references do not prove execution, and absence does not prove a tool is unused.
 * Documentation and test mentions are not evidence of an executable caller.
 * Workflow command validation and script-test discovery retain their own checks.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseDocument } from "yaml";
import {
  atomicWriteJsonSync,
  resolveReportArtifactPath,
} from "./lib/report-artifact-path.mjs";
import {
  assertContainedRegularFile,
  assertUniqueRepositoryIdentities,
  normalizeGitRepositoryPath,
} from "./lib/repository-file-integrity.mjs";
import { buildScriptTestInventory } from "./lib/script-test-inventory.mjs";
import { execFileSync } from "./lib/spawn-sync-captured.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const APP_PACKAGE_PATH = "packages/app/package.json";

const CATEGORIES = [
  "reachable-from-verify",
  "reachable-from-test",
  "reachable-from-build",
  "reachable-from-ci-workflow",
  "reachable-from-operator-script",
  "reachable-from-package-script",
  "unclassified",
];

const APP_CATEGORIES = [
  "reachable-from-verify",
  "reachable-from-test",
  "reachable-from-build",
  "reachable-from-ci-workflow",
  "reachable-from-operator-script",
  "unclassified",
];

/** Read one Git-named repository file without following symlinked components. */
export function readRepositoryCandidateText(repoRoot, relative, label) {
  const source = assertContainedRegularFile(
    repoRoot,
    relative,
    label ?? `script inventory source ${relative}`,
  );
  return readFileSync(source.absolute, "utf8");
}

function readRepositoryText(relative) {
  return readRepositoryCandidateText(ROOT, relative);
}

function readRepositoryJson(relative) {
  const source = readRepositoryText(relative);
  try {
    return JSON.parse(source);
  } catch (error) {
    // error-policy:J2 identify the repository manifest that invalidated inventory
    throw new Error(`invalid JSON in script inventory source ${relative}`, {
      cause: error,
    });
  }
}

function repositoryCandidateFiles() {
  const files = execFileSync(
    "git",
    [
      "-C",
      ROOT,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  )
    .split("\0")
    .filter(Boolean)
    // `git ls-files --cached` includes index entries deleted in the worktree.
    // Inventory the checkout that CI and local commands can actually execute,
    // while retaining symlinks for the containment validator below to reject.
    .filter((file) => {
      try {
        const metadata = lstatSync(path.join(ROOT, file));
        return metadata.isFile() || metadata.isSymbolicLink();
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    })
    .map((file) =>
      normalizeGitRepositoryPath(file, "script inventory candidate"),
    )
    .sort();
  assertUniqueRepositoryIdentities(
    files,
    "case-colliding or duplicate script inventory candidates",
  );
  return files;
}

/** Extract executable workflow step bodies without treating comments or env as calls. */
export function workflowExecutionSteps(source, file = "<workflow>") {
  const document = parseDocument(source, {
    merge: false,
    prettyErrors: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(
      `invalid workflow YAML in ${file}: ${document.errors[0].message}`,
    );
  }
  const root = document.toJS();
  const jobs =
    root && typeof root === "object" && !Array.isArray(root)
      ? root.jobs
      : undefined;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) return [];
  const workflowWorkingDirectory = readWorkflowWorkingDirectory(root);
  const executionSteps = [];
  for (const [jobName, job] of Object.entries(jobs)) {
    if (!job || typeof job !== "object" || !Array.isArray(job.steps)) continue;
    const jobWorkingDirectory =
      readWorkflowWorkingDirectory(job) ?? workflowWorkingDirectory;
    for (const step of job.steps) {
      if (!step || typeof step !== "object" || !Object.hasOwn(step, "run")) {
        continue;
      }
      if (typeof step.run !== "string") {
        throw new Error(`workflow run step in ${file} must be a string`);
      }
      executionSteps.push({
        job: jobName,
        run: step.run,
        workingDirectory:
          typeof step["working-directory"] === "string"
            ? step["working-directory"]
            : jobWorkingDirectory,
      });
    }
  }
  return executionSteps;
}

function readWorkflowWorkingDirectory(scope) {
  const defaults = scope?.defaults;
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
    return undefined;
  }
  const run = defaults.run;
  if (!run || typeof run !== "object" || Array.isArray(run)) return undefined;
  return typeof run["working-directory"] === "string"
    ? run["working-directory"]
    : undefined;
}

function isRepositoryRootDirectory(directory) {
  if (directory === undefined || directory === ".") return true;
  return [
    "$GITHUB_WORKSPACE",
    "$" + "{GITHUB_WORKSPACE}",
    "$" + "{{ github.workspace }}",
  ].includes(directory);
}

function directoryAfterCd(command, currentlyAtRoot) {
  const match = command.match(
    /(?:^|\s)(?:if\s+|then\s+|elif\s+|while\s+|until\s+|do\s+)?cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/,
  );
  if (!match) return currentlyAtRoot;
  return isRepositoryRootDirectory(match[1] ?? match[2] ?? match[3]);
}

/** Root package scripts executed by one parsed workflow. */
export function workflowRootScriptReferences(source, file = "<workflow>") {
  const references = [];
  for (const step of workflowExecutionSteps(source, file)) {
    let atRepositoryRoot = isRepositoryRootDirectory(step.workingDirectory);
    for (const command of step.run.split(/&&|\|\||[;|\n]/)) {
      if (command.trimStart().startsWith("#")) continue;
      atRepositoryRoot = directoryAfterCd(command, atRepositoryRoot);
      if (!atRepositoryRoot) continue;
      for (const script of referencedRootScripts(command)) {
        references.push({ file, job: step.job, script });
      }
    }
  }
  return references;
}

/** Missing root package scripts referenced from executable workflow steps. */
export function missingWorkflowRootScriptReferences(
  workflowSources,
  rootScripts,
) {
  return workflowSources
    .flatMap(({ file, source }) => workflowRootScriptReferences(source, file))
    .filter(({ script }) => !Object.hasOwn(rootScripts, script));
}

function loc(relative) {
  const text = readRepositoryText(relative);
  return text.split("\n").length;
}

/** All packages/scripts/*.mjs basenames (the file universe we classify). */
function collectScriptFiles(candidateFiles) {
  const files = candidateFiles
    .filter((file) => /^packages\/scripts\/[^/]+\.mjs$/i.test(file))
    .map((file) => path.posix.basename(file))
    .sort();
  const identities = new Map();
  for (const file of files) {
    const identity = file.toLocaleLowerCase("en-US");
    const previous = identities.get(identity);
    if (previous && previous !== file) {
      throw new Error(
        `case-colliding top-level script files: ${previous} and ${file}`,
      );
    }
    identities.set(identity, file);
  }
  return files;
}

/** Root-script names invoked from a script body via `bun|npm|pnpm|yarn run X`. */
function referencedRootScripts(body) {
  const names = new Set();
  const re =
    /\b(?:bun|npm|pnpm|yarn)\s+(?:--silent\s+)?run\s+([a-z0-9][a-z0-9:_-]*)(?=$|\s|[;&|)])/gi;
  for (const match of body.matchAll(re)) names.add(match[1]);
  return names;
}

/** packages/scripts/*.mjs basenames named anywhere in a text body. */
function referencedScriptFiles(body, fileUniverse) {
  const found = new Set();
  const universe = new Set(fileUniverse);
  const tokenPattern =
    /(?:^|[^A-Za-z0-9_.-])([A-Za-z0-9][A-Za-z0-9._-]*\.mjs)(?=$|[^A-Za-z0-9_.-])/g;
  for (const match of body.matchAll(tokenPattern)) {
    if (universe.has(match[1])) found.add(match[1]);
  }
  return found;
}

/** BFS the root-script call graph from a set of seed names. */
function reachableRootScripts(seeds, rootScripts) {
  const reached = new Set();
  const queue = [...seeds];
  while (queue.length) {
    const name = queue.shift();
    if (reached.has(name)) continue;
    if (!(name in rootScripts)) continue;
    reached.add(name);
    for (const next of referencedRootScripts(rootScripts[name])) {
      if (!reached.has(next)) queue.push(next);
    }
  }
  return reached;
}

/** Seed files named directly in reachable root-script bodies. */
function filesFromRootScripts(reachedRoots, rootScripts, fileUniverse) {
  const seeds = new Set();
  for (const name of reachedRoots) {
    for (const file of referencedScriptFiles(
      rootScripts[name] ?? "",
      fileUniverse,
    )) {
      seeds.add(file);
    }
  }
  return seeds;
}

/** Root `package.json` script callers for packages/scripts/*.mjs files. */
function filesFromOperatorScripts(reachedRoots, rootScripts, fileUniverse) {
  const callersByFile = new Map();
  for (const name of reachedRoots) {
    for (const scriptFile of referencedScriptFiles(
      rootScripts[name] ?? "",
      fileUniverse,
    )) {
      if (!callersByFile.has(scriptFile)) callersByFile.set(scriptFile, []);
      callersByFile.get(scriptFile).push({
        packageJson: "package.json",
        script: name,
      });
    }
  }

  for (const callers of callersByFile.values()) {
    callers.sort((a, b) =>
      `${a.packageJson}:${a.script}`.localeCompare(
        `${b.packageJson}:${b.script}`,
      ),
    );
  }
  return callersByFile;
}

/**
 * packages/scripts files invoked from package-local `package.json` scripts.
 *
 * Root reachability intentionally remains its own color; this catches the other
 * public package script surface so helpers used by a package command are not
 * reported as disposable just because root verify/build/CI do not call them.
 */
function filesFromPackageScripts(fileUniverse, candidateFiles) {
  const callersByFile = new Map();
  for (const relativeFile of candidateFiles) {
    if (path.posix.basename(relativeFile) !== "package.json") continue;
    if (relativeFile === "package.json") continue;
    const pkg = readRepositoryJson(relativeFile);
    const scripts = pkg.scripts ?? {};
    for (const [name, body] of Object.entries(scripts)) {
      for (const scriptFile of referencedScriptFiles(body, fileUniverse)) {
        if (!callersByFile.has(scriptFile)) callersByFile.set(scriptFile, []);
        callersByFile.get(scriptFile).push({
          packageJson: relativeFile,
          script: name,
        });
      }
    }
  }

  for (const callers of callersByFile.values()) {
    callers.sort((a, b) =>
      `${a.packageJson}:${a.script}`.localeCompare(
        `${b.packageJson}:${b.script}`,
      ),
    );
  }
  return callersByFile;
}

/**
 * Turbo task names a body fans out across the workspace via
 * `run-turbo.mjs run <task…>` / `turbo run <task…>`. Turbo runs each task on
 * every workspace package, so a fan-out task reaches packages/app's same-named
 * script — unless the invocation carries a positive `--filter=@elizaos/<pkg>`
 * allowlist that omits app (e.g. `build:core`). Negative `--filter=!…` filters
 * still include app, and Turbo's dependency selectors `<pkg>...` (with-deps) /
 * `...<pkg>` (with-dependents) both include the named package, so the leading/
 * trailing `...` is stripped before the equality check.
 */
function turboFanoutTasks(body) {
  const positiveElizaFilters = [
    ...body.matchAll(
      /--filter=['"]?(?:\.\.\.)?(@elizaos\/[a-z0-9-]+)(?:\.\.\.)?/g,
    ),
  ].map((m) => m[1]);
  if (
    positiveElizaFilters.length &&
    !positiveElizaFilters.some((f) => f === "@elizaos/app")
  ) {
    return new Set(); // restricted to a package set that excludes app
  }
  const tasks = new Set();
  const re = /(?:run-turbo\.mjs|\bturbo)\s+run\s+([a-z0-9:_\- ]+)/g;
  for (const match of body.matchAll(re)) {
    for (const token of match[1].split(/\s+/)) {
      if (/^[a-z0-9][a-z0-9:_-]*$/.test(token)) tasks.add(token);
      else break; // first flag/operator ends the task list
    }
  }
  return tasks;
}

/** App-script names a body invokes via `--cwd packages/app <name>`. */
function appScriptsViaCwd(body, appUniverse) {
  const found = new Set();
  const re = /--cwd\s+packages\/app\s+([a-z0-9][a-z0-9:_-]*)/gi;
  for (const match of body.matchAll(re)) {
    if (appUniverse.has(match[1])) found.add(match[1]);
  }
  return found;
}

/** App-script names a body invokes via a bare `bun|npm|pnpm|yarn run <name>`. */
function appScriptsViaRun(body, appUniverse) {
  const found = new Set();
  for (const name of referencedRootScripts(body)) {
    if (appUniverse.has(name)) found.add(name);
  }
  return found;
}

/**
 * App scripts referenced inside a `.github/` step whose `working-directory` is
 * packages/app — there the `run:` body invokes app scripts without `--cwd`.
 * Split each workflow into step blocks (list items under `steps:`) so a
 * working-directory in one step never bleeds onto another step's commands.
 */
function appScriptsFromCiWorkdir(workflowSteps, appUniverse) {
  const found = new Set();
  for (const step of workflowSteps) {
    if (step.workingDirectory !== "packages/app") continue;
    for (const name of referencedRootScripts(step.run)) {
      if (appUniverse.has(name)) found.add(name);
    }
  }
  return found;
}

/** npm lifecycle pairs present in the app scripts: `pre<x>`/`post<x>` → `<x>`. */
function lifecycleEdges(appUniverse) {
  const edges = new Map();
  for (const name of appUniverse) {
    const base = name.replace(/^(pre|post)/, "");
    if (base !== name && appUniverse.has(base)) edges.set(name, base);
  }
  return edges;
}

/** BFS app scripts: seeds + app→app `run` edges + lifecycle pre/post pairs. */
function reachableAppScripts(seeds, appScripts, appUniverse) {
  const lifecycle = lifecycleEdges(appUniverse);
  // base -> [pre/post wrappers] so reaching a base reaches its lifecycle hooks.
  const reverseLifecycle = new Map();
  for (const [hook, base] of lifecycle) {
    if (!reverseLifecycle.has(base)) reverseLifecycle.set(base, []);
    reverseLifecycle.get(base).push(hook);
  }
  const reached = new Set();
  const queue = [...seeds];
  while (queue.length) {
    const name = queue.shift();
    if (reached.has(name) || !appUniverse.has(name)) continue;
    reached.add(name);
    for (const next of appScriptsViaRun(appScripts[name] ?? "", appUniverse)) {
      if (!reached.has(next)) queue.push(next);
    }
    for (const hook of reverseLifecycle.get(name) ?? []) {
      if (!reached.has(hook)) queue.push(hook);
    }
  }
  return reached;
}

function buildInventory() {
  const rootScripts = readRepositoryJson("package.json").scripts ?? {};
  const candidateFiles = repositoryCandidateFiles();
  const fileUniverse = collectScriptFiles(candidateFiles);
  if (fileUniverse.length === 0) {
    throw new Error(
      "packages/scripts inventory discovered zero top-level files",
    );
  }
  const packageScriptCallersByFile = filesFromPackageScripts(
    fileUniverse,
    candidateFiles,
  );

  // CI workflow corpus + the root-script names + script files it references.
  const workflowFiles = candidateFiles.filter((file) =>
    /^\.github\/.*\.ya?ml$/i.test(file),
  );
  if (workflowFiles.length === 0) {
    throw new Error("script inventory discovered zero GitHub workflows");
  }
  const workflowSources = workflowFiles.map((file) => ({
    file,
    source: readRepositoryText(file),
  }));
  const workflowSteps = workflowSources.flatMap(({ file, source }) =>
    workflowExecutionSteps(source, file),
  );
  const ciText = workflowSteps.map(({ run }) => run).join("\n");
  const ciWorkflowPath = ".github/workflows/ci.yml";
  if (!candidateFiles.includes(ciWorkflowPath)) {
    throw new Error(`script inventory is missing ${ciWorkflowPath}`);
  }
  const scriptTests = buildScriptTestInventory({
    repoRoot: ROOT,
    candidateFiles,
    packageScripts: rootScripts,
    ciWorkflow: readRepositoryText(ciWorkflowPath),
  });
  const missingWorkflowScripts = missingWorkflowRootScriptReferences(
    workflowSources,
    rootScripts,
  );
  if (missingWorkflowScripts.length > 0) {
    throw new Error(
      `GitHub workflows reference missing root package scripts:\n${missingWorkflowScripts
        .map(({ file, job, script }) => `- ${file} (${job}): ${script}`)
        .join("\n")}`,
    );
  }
  const ciRootSeeds = new Set(
    workflowSources.flatMap(({ file, source }) =>
      workflowRootScriptReferences(source, file).map(({ script }) => script),
    ),
  );
  const ciFileSeeds = referencedScriptFiles(ciText, fileUniverse);

  // Reachable root-script sets per seed entrypoint.
  const verifyRoots = reachableRootScripts(["verify", "check"], rootScripts);
  const testRoots = reachableRootScripts(["test"], rootScripts);
  const buildRoots = reachableRootScripts(["build"], rootScripts);
  const ciRoots = reachableRootScripts(ciRootSeeds, rootScripts);
  const operatorRoots = reachableRootScripts(
    Object.keys(rootScripts),
    rootScripts,
  );
  const operatorScriptCallersByFile = filesFromOperatorScripts(
    operatorRoots,
    rootScripts,
    fileUniverse,
  );

  // Only command bodies and the executable test inventory seed file categories.
  // A source comment or self-test mentioning a helper cannot establish a caller.
  const verifyFiles = filesFromRootScripts(
    verifyRoots,
    rootScripts,
    fileUniverse,
  );
  const testFiles = new Set([
    ...filesFromRootScripts(testRoots, rootScripts, fileUniverse),
    ...scriptTests.files
      .map(({ file }) => file)
      .filter((file) => /^packages\/scripts\/[^/]+\.mjs$/.test(file))
      .map((file) => path.posix.basename(file)),
  ]);
  const buildFiles = filesFromRootScripts(
    buildRoots,
    rootScripts,
    fileUniverse,
  );
  const ciFiles = new Set([
    ...filesFromRootScripts(ciRoots, rootScripts, fileUniverse),
    ...ciFileSeeds,
  ]);
  const operatorFiles = new Set(operatorScriptCallersByFile.keys());
  const packageScriptFiles = new Set(packageScriptCallersByFile.keys());

  const classifyRoot = (name) => {
    if (verifyRoots.has(name)) return "reachable-from-verify";
    if (testRoots.has(name)) return "reachable-from-test";
    if (buildRoots.has(name)) return "reachable-from-build";
    if (ciRoots.has(name)) return "reachable-from-ci-workflow";
    if (operatorRoots.has(name)) return "reachable-from-operator-script";
    return "unclassified";
  };
  const classifyFile = (file) => {
    if (verifyFiles.has(file)) return "reachable-from-verify";
    if (testFiles.has(file)) return "reachable-from-test";
    if (buildFiles.has(file)) return "reachable-from-build";
    if (ciFiles.has(file)) return "reachable-from-ci-workflow";
    if (operatorFiles.has(file)) return "reachable-from-operator-script";
    if (packageScriptFiles.has(file)) return "reachable-from-package-script";
    return "unclassified";
  };

  const files = fileUniverse.map((file) => ({
    file,
    loc: loc(`packages/scripts/${file}`),
    category: classifyFile(file),
    operatorScriptCallers: operatorScriptCallersByFile.get(file) ?? [],
    packageScriptCallers: packageScriptCallersByFile.get(file) ?? [],
  }));
  const roots = Object.keys(rootScripts).map((name) => ({
    name,
    category: classifyRoot(name),
  }));

  const fileTotals = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  const fileLocTotals = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const f of files) {
    fileTotals[f.category] += 1;
    fileLocTotals[f.category] += f.loc;
  }
  const rootTotals = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const r of roots) rootTotals[r.category] += 1;

  // packages/app — the second dense script surface (issue #10200, item 2). An app
  // script is reachable when a reachable root script or a CI workflow invokes it
  // (via `--cwd packages/app <name>` or a `working-directory: packages/app` step),
  // or when another reachable app script / npm lifecycle hook chains to it.
  const appScripts = existsSync(path.join(ROOT, APP_PACKAGE_PATH))
    ? (readRepositoryJson(APP_PACKAGE_PATH).scripts ?? {})
    : {};
  const appUniverse = new Set(Object.keys(appScripts));

  const appSeedsByColor = {
    "reachable-from-verify": new Set(),
    "reachable-from-test": new Set(),
    "reachable-from-build": new Set(),
    "reachable-from-ci-workflow": new Set(),
    // Named root commands an operator runs by hand (e.g. root `lint` fanning
    // out Turbo's `lint` across the workspace) still reach app scripts; since
    // the read-only gate split (root verify fans out `lint:check`), this is the
    // only color that reaches app `lint`.
    "reachable-from-operator-script": new Set(),
  };
  for (const name of Object.keys(rootScripts)) {
    const color = classifyRoot(name);
    if (!(color in appSeedsByColor)) continue;
    for (const app of appScriptsViaCwd(rootScripts[name], appUniverse)) {
      appSeedsByColor[color].add(app);
    }
    // Turbo fan-out: `run-turbo run build|lint|typecheck|…` reaches app's
    // same-named script across the whole workspace.
    for (const task of turboFanoutTasks(rootScripts[name])) {
      if (appUniverse.has(task)) appSeedsByColor[color].add(task);
    }
  }
  for (const app of appScriptsViaCwd(ciText, appUniverse)) {
    appSeedsByColor["reachable-from-ci-workflow"].add(app);
  }
  for (const app of appScriptsFromCiWorkdir(workflowSteps, appUniverse)) {
    appSeedsByColor["reachable-from-ci-workflow"].add(app);
  }

  const verifyApp = reachableAppScripts(
    appSeedsByColor["reachable-from-verify"],
    appScripts,
    appUniverse,
  );
  const testApp = reachableAppScripts(
    appSeedsByColor["reachable-from-test"],
    appScripts,
    appUniverse,
  );
  const buildApp = reachableAppScripts(
    appSeedsByColor["reachable-from-build"],
    appScripts,
    appUniverse,
  );
  const ciApp = reachableAppScripts(
    appSeedsByColor["reachable-from-ci-workflow"],
    appScripts,
    appUniverse,
  );
  const operatorApp = reachableAppScripts(
    appSeedsByColor["reachable-from-operator-script"],
    appScripts,
    appUniverse,
  );
  const classifyApp = (name) => {
    if (verifyApp.has(name)) return "reachable-from-verify";
    if (testApp.has(name)) return "reachable-from-test";
    if (buildApp.has(name)) return "reachable-from-build";
    if (ciApp.has(name)) return "reachable-from-ci-workflow";
    if (operatorApp.has(name)) return "reachable-from-operator-script";
    return "unclassified";
  };
  const appScriptList = Object.keys(appScripts).map((name) => ({
    name,
    category: classifyApp(name),
  }));
  const appTotals = Object.fromEntries(APP_CATEGORIES.map((c) => [c, 0]));
  for (const a of appScriptList) appTotals[a.category] += 1;

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalFiles: files.length,
      totalLoc: files.reduce((sum, f) => sum + f.loc, 0),
      unclassifiedFiles: fileTotals.unclassified,
      unclassifiedLoc: fileLocTotals.unclassified,
      totalRootScripts: roots.length,
      unclassifiedRootScripts: rootTotals.unclassified,
      filesByCategory: fileTotals,
      locByCategory: fileLocTotals,
      rootScriptsByCategory: rootTotals,
      packageScriptFileReferences: [
        ...packageScriptCallersByFile.values(),
      ].reduce((sum, callers) => sum + callers.length, 0),
      operatorScriptFileReferences: [
        ...operatorScriptCallersByFile.values(),
      ].reduce((sum, callers) => sum + callers.length, 0),
      totalAppScripts: appScriptList.length,
      unclassifiedAppScripts: appTotals.unclassified,
      appScriptsByCategory: appTotals,
      totalScriptTests: scriptTests.discoveredCount,
      excludedScriptTests: scriptTests.excludedCount,
    },
    files,
    roots,
    appScripts: appScriptList,
    scriptTests,
  };
}

function printSummary(inv) {
  const { summary } = inv;
  const w = process.stdout.write.bind(process.stdout);
  const categoryWidth = 31;
  w("\n[audit-scripts-inventory] packages/scripts/*.mjs static references\n\n");
  w(`  ${"category".padEnd(categoryWidth)} files     loc   roots\n`);
  w(`  ${"-".repeat(categoryWidth)} ------- ------- -------\n`);
  for (const c of CATEGORIES) {
    w(
      `  ${c.padEnd(categoryWidth)} ${String(summary.filesByCategory[c]).padStart(5)} ` +
        `${String(summary.locByCategory[c]).padStart(7)} ` +
        `${String(summary.rootScriptsByCategory[c]).padStart(7)}\n`,
    );
  }
  w(`  ${"-".repeat(categoryWidth)} ------- ------- -------\n`);
  w(
    `  ${"TOTAL".padEnd(categoryWidth)} ${String(summary.totalFiles).padStart(5)} ` +
      `${String(summary.totalLoc).padStart(7)} ` +
      `${String(summary.totalRootScripts).padStart(7)}\n\n`,
  );
  w(
    `  total files: ${summary.totalFiles}  total LOC: ${summary.totalLoc}  ` +
      `unclassified files: ${summary.unclassifiedFiles} (${summary.unclassifiedLoc} LOC)  ` +
      `root scripts: ${summary.totalRootScripts} (${summary.unclassifiedRootScripts} unclassified)\n\n`,
  );
  const orphans = inv.files.filter((f) => f.category === "unclassified");
  if (orphans.length) {
    w("  unclassified files:\n");
    for (const f of orphans) w(`    - ${f.file} (${f.loc} LOC)\n`);
    w(
      "\n  note: unclassified here means no root/CI/package-script caller found, " +
        'not "safe to delete". Root operator commands are tracked separately.\n\n',
    );
  }

  // packages/app — the second dense script surface (issue #10200, item 2).
  w(
    "[audit-scripts-inventory] packages/app/package.json static references\n\n",
  );
  w("  category                         scripts\n");
  w("  ------------------------------ ---------\n");
  for (const c of APP_CATEGORIES) {
    w(
      `  ${c.padEnd(30)} ${String(summary.appScriptsByCategory[c]).padStart(7)}\n`,
    );
  }
  w("  ---------------------------- ---------\n");
  w(
    `  ${"TOTAL".padEnd(28)} ${String(summary.totalAppScripts).padStart(7)}\n\n`,
  );
  w(
    `  app scripts: ${summary.totalAppScripts} (${summary.unclassifiedAppScripts} ` +
      `with no detected automated caller)\n` +
      '  note: unclassified here means "no root/CI/app-internal caller found", not ' +
      '"safe to delete" — many are\n  human/maintainer entrypoints ' +
      "(build:ios:*, capture:*, preflight:*), the same as root DEV-ENTRY scripts.\n\n",
  );
  const appOrphans = inv.appScripts.filter(
    (a) => a.category === "unclassified",
  );
  if (appOrphans.length) {
    w("  app scripts with no detected automated caller:\n");
    for (const a of appOrphans) w(`    - ${a.name}\n`);
    w("\n");
  }

  w("[audit-scripts-inventory] packages/scripts executable tests\n\n");
  w(
    `  discovered: ${summary.totalScriptTests}  explicit exclusions: ${summary.excludedScriptTests}\n`,
  );
  w(
    `  runner: ${inv.scriptTests.runner.command}\n  lanes: ${inv.scriptTests.runner.lanes.join(", ")}\n\n`,
  );
}

export function parseInventoryArgs(args) {
  const supported = new Set(["--help", "-h", "--json"]);
  for (const arg of args) {
    if (!supported.has(arg)) {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (new Set(args).size !== args.length) {
    throw new Error("arguments may be specified only once");
  }
  const helpFlags = args.filter((arg) => arg === "--help" || arg === "-h");
  if (helpFlags.length > 1) {
    throw new Error("help may be specified only once");
  }
  if (helpFlags.length === 1 && args.length !== 1) {
    throw new Error("help cannot be combined with inventory arguments");
  }
  return {
    help: args.includes("--help") || args.includes("-h"),
    json: args.includes("--json"),
  };
}

function printUsage() {
  process.stdout.write(
    "Usage: node packages/scripts/audit-scripts-inventory.mjs [--json]\n",
  );
}

function writeJsonAtomic(file, value) {
  atomicWriteJsonSync(file, value);
}

function main() {
  const options = parseInventoryArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  const inv = buildInventory();

  if (options.json) {
    process.stdout.write(`${JSON.stringify(inv, null, 2)}\n`);
    return;
  }

  const outDir = path.join(ROOT, "reports");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outFile = resolveReportArtifactPath(
    ROOT,
    "reports/scripts-inventory.json",
    {
      extension: ".json",
      label: "scripts inventory report",
    },
  ).absolute;
  writeJsonAtomic(outFile, inv);
  printSummary(inv);
  process.stdout.write(`  JSON written to ${path.relative(ROOT, outFile)}\n\n`);
}

export { buildInventory };

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    // error-policy:J1 the executable boundary translates incomplete discovery
    // or invalid input into a non-zero audit result.
    process.stderr.write(
      `[audit-scripts-inventory] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
