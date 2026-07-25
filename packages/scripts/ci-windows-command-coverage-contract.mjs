#!/usr/bin/env node
/**
 * Validates that every command selected by the Windows CI matrix resolves to
 * executable repository source. The workflow remains the coverage authority;
 * this contract rejects empty lanes, duplicate wiring, stale package scripts,
 * and missing entrypoints without comparing against a historical inventory.
 */
import { globSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const WORKFLOW_FILE = ".github/workflows/windows-ci.yml";
const JOB_KEY = "windows";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function indentOf(line) {
  return line.match(/^ */)?.[0].length ?? 0;
}

function unquoteScalar(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readJson(path, description) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${description} is not readable JSON: ${error.message}`, {
      cause: error,
    });
  }
}

function assertRepoFile(repoRoot, path, description) {
  assert(
    typeof path === "string" &&
      path.length > 0 &&
      !isAbsolute(path) &&
      !path.includes("\\") &&
      !path.split("/").includes(".."),
    `${description} must be a normalized repository-relative path`,
  );
  const absolute = resolve(repoRoot, path);
  const fromRoot = relative(repoRoot, absolute);
  assert(
    fromRoot !== ".." &&
      !fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`),
    `${description} escapes the repository`,
  );
  try {
    assert(statSync(absolute).isFile(), `${description} is not a regular file`);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("is not a regular file")
    ) {
      throw error;
    }
    throw new Error(`${description} does not exist: ${path}`, { cause: error });
  }
  return absolute;
}

function jobBlockLines(workflowText, jobKey) {
  const lines = workflowText.split(/\r?\n/);
  const jobsIndex = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  assert(jobsIndex >= 0, `${WORKFLOW_FILE}: no top-level "jobs:" mapping`);

  let start = -1;
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    if (new RegExp(`^ {2}${jobKey}:\\s*$`).test(lines[index])) {
      start = index;
      break;
    }
  }
  assert(start >= 0, `${WORKFLOW_FILE}: no "${jobKey}" job under "jobs:"`);

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() !== "" && /^ {2}\S/.test(line)) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end);
}

/**
 * Reads the lane names and command lists from
 * `jobs.windows.strategy.matrix.include`.
 */
export function parseWindowsMatrix(repoRoot = DEFAULT_REPO_ROOT) {
  const workflowPath = resolve(repoRoot, WORKFLOW_FILE);
  const lines = jobBlockLines(readFileSync(workflowPath, "utf8"), JOB_KEY);
  const includeIndex = lines.findIndex((line) => /^\s+include:\s*$/.test(line));
  assert(
    includeIndex >= 0,
    `${WORKFLOW_FILE}: no strategy.matrix.include list in "${JOB_KEY}" job`,
  );

  const includeIndent = indentOf(lines[includeIndex]);
  const entryIndent = includeIndent + 2;
  const lanes = [];
  let currentLane = null;
  let commandsIndent = null;

  for (let index = includeIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = indentOf(line);
    if (indent <= includeIndent) break;

    const laneMatch = line.match(
      new RegExp(`^ {${entryIndent}}-\\s+lane:\\s*(.+?)\\s*$`),
    );
    if (laneMatch) {
      currentLane = {
        lane: unquoteScalar(laneMatch[1]),
        commands: [],
      };
      lanes.push(currentLane);
      commandsIndent = null;
      continue;
    }

    if (new RegExp(`^ {${entryIndent}}-\\s+`).test(line)) {
      throw new Error(
        `${WORKFLOW_FILE}: every "${JOB_KEY}" matrix entry must start with a lane`,
      );
    }
    if (currentLane === null) continue;

    if (/^\s*commands:\s*$/.test(line)) {
      commandsIndent = indent;
      continue;
    }
    if (commandsIndent === null) continue;
    if (indent <= commandsIndent) {
      commandsIndent = null;
      continue;
    }

    const item = line.slice(indent).match(/^-\s+(.+?)\s*$/);
    assert(
      item !== null,
      `${WORKFLOW_FILE}: malformed command list in lane "${currentLane.lane}" (got ${JSON.stringify(line)})`,
    );
    currentLane.commands.push(unquoteScalar(item[1]));
  }

  return lanes;
}

function validateMatrix(lanes) {
  assert(
    lanes.length > 0,
    `${WORKFLOW_FILE}: "${JOB_KEY}" matrix must declare at least one lane`,
  );
  const laneNames = new Set();
  const commands = new Map();
  for (const lane of lanes) {
    assert(
      typeof lane.lane === "string" && lane.lane.length > 0,
      `${WORKFLOW_FILE}: every "${JOB_KEY}" matrix lane needs a name`,
    );
    assert(
      !laneNames.has(lane.lane),
      `${WORKFLOW_FILE}: duplicate "${JOB_KEY}" matrix lane "${lane.lane}"`,
    );
    laneNames.add(lane.lane);
    assert(
      Array.isArray(lane.commands) && lane.commands.length > 0,
      `${WORKFLOW_FILE}: lane "${lane.lane}" must execute at least one command`,
    );
    for (const command of lane.commands) {
      assert(
        typeof command === "string" && command.length > 0,
        `${WORKFLOW_FILE}: lane "${lane.lane}" contains an empty command`,
      );
      const owner = commands.get(command);
      assert(
        owner === undefined,
        `${WORKFLOW_FILE}: command is duplicated in lanes "${owner}" and "${lane.lane}": ${command}`,
      );
      commands.set(command, lane.lane);
    }
  }
}

function workspacePackageIndex(repoRoot) {
  const rootManifest = readJson(
    resolve(repoRoot, "package.json"),
    "root package.json",
  );
  assert(
    Array.isArray(rootManifest.workspaces) &&
      rootManifest.workspaces.every((entry) => typeof entry === "string"),
    "root package.json workspaces must be a string array",
  );
  const excluded = new Set(
    rootManifest.workspaces
      .filter((entry) => entry.startsWith("!"))
      .map((entry) => `${entry.slice(1)}/package.json`),
  );
  const manifests = new Set(["package.json"]);
  for (const workspace of rootManifest.workspaces) {
    if (workspace.startsWith("!")) continue;
    for (const manifestPath of globSync(`${workspace}/package.json`, {
      cwd: repoRoot,
      exclude: ["**/node_modules/**"],
    })) {
      const normalized = manifestPath.replaceAll("\\", "/");
      if (!excluded.has(normalized)) manifests.add(normalized);
    }
  }

  const packages = new Map();
  for (const manifestPath of manifests) {
    const manifest = readJson(resolve(repoRoot, manifestPath), manifestPath);
    if (typeof manifest.name !== "string" || manifest.name.length === 0) {
      continue;
    }
    const previous = packages.get(manifest.name);
    assert(
      previous === undefined,
      `workspace package name "${manifest.name}" is duplicated by ${previous?.path} and ${manifestPath}`,
    );
    packages.set(manifest.name, { manifest, path: manifestPath });
  }
  return packages;
}

function tokenize(command) {
  assert(
    !/[;&|<>`]/.test(command),
    `compound shell syntax is unsupported in Windows matrix command: ${command}`,
  );
  const tokens = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+)/g;
  for (const match of command.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function resolvePackageScript(repoRoot, relativeDir, scriptName, command) {
  const manifestPath = `${relativeDir}/package.json`;
  const manifest = readJson(
    assertRepoFile(repoRoot, manifestPath, `${command}: package manifest`),
    manifestPath,
  );
  assert(
    typeof manifest.scripts?.[scriptName] === "string" &&
      manifest.scripts[scriptName].trim().length > 0,
    `${command}: ${manifestPath} has no executable "${scriptName}" script`,
  );
  return [manifestPath];
}

function turboFilters(tokens) {
  const filters = [];
  for (let index = 4; index < tokens.length; index += 1) {
    if (tokens[index] === "--filter") {
      assert(
        typeof tokens[index + 1] === "string",
        "run-turbo --filter requires a package name",
      );
      filters.push(tokens[index + 1]);
      index += 1;
    } else if (tokens[index].startsWith("--filter=")) {
      filters.push(tokens[index].slice("--filter=".length));
    }
  }
  return filters;
}

function resolveNodeCommand(repoRoot, tokens, command, packageIndex) {
  assert(
    tokens.length >= 2,
    `node command has no repository entrypoint: ${command}`,
  );
  const entrypoint = tokens[1];
  const sources = [
    relative(
      repoRoot,
      assertRepoFile(repoRoot, entrypoint, `${command}: Node entrypoint`),
    ).replaceAll("\\", "/"),
  ];

  if (entrypoint === "packages/scripts/run-turbo.mjs") {
    assert(
      tokens[2] === "run" && typeof tokens[3] === "string",
      `${command}: run-turbo command must select a task`,
    );
    const task = tokens[3];
    const filters = turboFilters(tokens);
    assert(
      filters.length > 0,
      `${command}: Windows run-turbo commands must name their package filters`,
    );
    for (const filter of filters) {
      assert(
        !/[*!?[\]{}]/.test(filter) && !filter.startsWith("."),
        `${command}: package filter "${filter}" must be an exact workspace package name`,
      );
      const workspace = packageIndex.get(filter);
      assert(
        workspace !== undefined,
        `${command}: package filter "${filter}" does not resolve to a workspace package`,
      );
      assert(
        typeof workspace.manifest.scripts?.[task] === "string" &&
          workspace.manifest.scripts[task].trim().length > 0,
        `${command}: ${workspace.path} has no executable "${task}" script`,
      );
      sources.push(workspace.path);
    }
  } else if (entrypoint === "packages/scripts/run-bash-linux-only.mjs") {
    assert(
      typeof tokens[2] === "string" && !tokens[2].startsWith("-"),
      `${command}: run-bash-linux-only requires a repository script`,
    );
    sources.push(
      relative(
        repoRoot,
        assertRepoFile(repoRoot, tokens[2], `${command}: wrapped script`),
      ).replaceAll("\\", "/"),
    );
  }
  return sources;
}

function resolveCommand(repoRoot, lane, command, packageIndex) {
  const tokens = tokenize(command);
  assert(tokens.length > 0, `${WORKFLOW_FILE}: lane "${lane}" has no command`);

  if (tokens[0] === "node") {
    return resolveNodeCommand(repoRoot, tokens, command, packageIndex);
  }
  if (tokens[0] === "bun" && tokens[1] === "run") {
    const cwdIndex = tokens.indexOf("--cwd");
    assert(
      cwdIndex >= 0 &&
        typeof tokens[cwdIndex + 1] === "string" &&
        typeof tokens[cwdIndex + 2] === "string",
      `${command}: bun run command must include --cwd <package> <script>`,
    );
    return resolvePackageScript(
      repoRoot,
      tokens[cwdIndex + 1],
      tokens[cwdIndex + 2],
      command,
    );
  }
  throw new Error(
    `${WORKFLOW_FILE}: lane "${lane}" uses unsupported command shape: ${command}`,
  );
}

export function runContract(repoRoot = DEFAULT_REPO_ROOT) {
  const lanes = parseWindowsMatrix(repoRoot);
  validateMatrix(lanes);
  const packageIndex = workspacePackageIndex(repoRoot);
  const resolved = [];
  for (const lane of lanes) {
    for (const command of lane.commands) {
      resolved.push({
        lane: lane.lane,
        command,
        sources: resolveCommand(repoRoot, lane.lane, command, packageIndex),
      });
    }
  }
  return {
    laneCount: lanes.length,
    commandCount: resolved.length,
    resolved,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { laneCount, commandCount } = runContract();
    console.log(
      `ci windows command source contract passed ` +
        `(${laneCount} lane(s); ${commandCount} command(s) resolved)`,
    );
  } catch (error) {
    console.error(
      `[ci-windows-command-coverage-contract] FAIL ${error.message}`,
    );
    process.exit(1);
  }
}
