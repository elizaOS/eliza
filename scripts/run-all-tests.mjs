import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const bunCmd = process.env.npm_execpath || process.env.BUN || "bun";

const EXTRA_SCRIPT_NAMES = [
  "test:integration",
  "test:e2e",
  "test:playwright",
  "test:ui",
  "test:live",
];
const NO_TEST_OUTPUT_PATTERNS = [
  /No test files found/i,
  /No tests found/i,
];
const MAX_CAPTURED_OUTPUT_CHARS = 16_000;
const ADDITIONAL_PACKAGE_DIRS = [
  path.join(repoRoot, "packages", "app-core", "platforms", "electrobun"),
];
const packageFilter = process.env.TEST_PACKAGE_FILTER
  ? new RegExp(process.env.TEST_PACKAGE_FILTER)
  : null;
const scriptFilter = process.env.TEST_SCRIPT_FILTER
  ? new RegExp(process.env.TEST_SCRIPT_FILTER)
  : null;
const startAt = process.env.TEST_START_AT?.trim() || "";
const DEFAULT_POSTGRES_URL = "postgresql://eliza_test:test123@localhost:5432/eliza_test";
const POSTGRES_INIT_SQL_PATH = path.join(
  repoRoot,
  "plugins",
  "plugin-sql",
  "scripts",
  "init-test-db.sql",
);

function expandWorkspacePattern(pattern) {
  const segments = pattern.split("/").filter(Boolean);
  let currentPaths = [repoRoot];

  for (const segment of segments) {
    const nextPaths = [];
    for (const currentPath of currentPaths) {
      if (segment === "*") {
        if (!fs.existsSync(currentPath)) {
          continue;
        }
        const entries = fs
          .readdirSync(currentPath, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          nextPaths.push(path.join(currentPath, entry.name));
        }
        continue;
      }
      nextPaths.push(path.join(currentPath, segment));
    }
    currentPaths = nextPaths;
  }

  return currentPaths;
}

function collectPackageJsonPaths() {
  const rootPackageJson = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  const packageJsonPaths = new Set();

  for (const pattern of rootPackageJson.workspaces ?? []) {
    for (const packageDir of expandWorkspacePattern(pattern)) {
      const packageJsonPath = path.join(packageDir, "package.json");
      if (fs.existsSync(packageJsonPath)) {
        packageJsonPaths.add(packageJsonPath);
      }
    }
  }

  for (const packageDir of ADDITIONAL_PACKAGE_DIRS) {
    const packageJsonPath = path.join(packageDir, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      packageJsonPaths.add(packageJsonPath);
    }
  }

  return [...packageJsonPaths].sort((left, right) => left.localeCompare(right));
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function resolveScriptCommand(scriptName, scripts, seen = new Set()) {
  const raw = normalizeWhitespace(scripts?.[scriptName] ?? "");
  if (!raw) {
    return "";
  }
  if (seen.has(scriptName)) {
    return raw;
  }
  seen.add(scriptName);

  const aliasMatch = raw.match(/^(?:bun|npm|pnpm|yarn)(?:\s+run)?\s+([A-Za-z0-9:_-]+)$/);
  if (aliasMatch?.[1] && scripts?.[aliasMatch[1]]) {
    return resolveScriptCommand(aliasMatch[1], scripts, seen);
  }

  return raw;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "pipe",
    encoding: "utf8",
    ...options,
  });

  const combinedOutput = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return {
    ...result,
    combinedOutput,
  };
}

function resetPostgresDatabase() {
  const terminateResult = runCommand("psql", [
    "postgres",
    "-c",
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'eliza_test' AND pid <> pg_backend_pid()",
  ]);
  if (terminateResult.status !== 0) {
    throw new Error(terminateResult.combinedOutput || "failed to terminate active PostgreSQL test connections");
  }

  const dropResult = runCommand("dropdb", ["--if-exists", "eliza_test"]);
  if (dropResult.status !== 0) {
    throw new Error(dropResult.combinedOutput || "failed to drop local PostgreSQL test database");
  }

  const createResult = runCommand("createdb", ["eliza_test"]);
  if (createResult.status !== 0) {
    throw new Error(createResult.combinedOutput || "failed to recreate local PostgreSQL test database");
  }
}

function ensurePluginSqlPostgresEnv() {
  if (process.env.POSTGRES_URL?.trim()) {
    return;
  }

  if (!fs.existsSync(POSTGRES_INIT_SQL_PATH)) {
    return;
  }

  const pingResult = runCommand("psql", ["postgres", "-Atc", "SELECT 1"]);
  if (pingResult.status !== 0) {
    console.warn(
      "[eliza-test] WARN local PostgreSQL unavailable; plugin-sql Postgres-only suites will remain skipped",
    );
    return;
  }

  try {
    resetPostgresDatabase();
    const initResult = runCommand("psql", [
      "-v",
      "ON_ERROR_STOP=1",
      "-d",
      "eliza_test",
      "-f",
      POSTGRES_INIT_SQL_PATH,
    ]);
    if (initResult.status !== 0) {
      throw new Error(initResult.combinedOutput || "failed to initialize local PostgreSQL test database");
    }
    process.env.POSTGRES_URL = DEFAULT_POSTGRES_URL;
    console.log(`[eliza-test] INFO using PostgreSQL test database at ${DEFAULT_POSTGRES_URL}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[eliza-test] WARN failed to prepare local PostgreSQL test database; plugin-sql Postgres-only suites may be skipped (${message})`,
    );
  }
}

function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scriptReferencesScript(command, scriptName) {
  if (!command) {
    return false;
  }
  const escapedName = escapeForRegex(scriptName);
  const referencePattern = new RegExp(
    `(?:^|[;&|]\\s*|&&\\s*|\\|\\|\\s*)(?:bun|npm|pnpm|yarn)(?:\\s+run)?\\s+${escapedName}(?:\\s|$)`,
  );
  return referencePattern.test(command);
}

function getReferencedScriptNames(command, scripts) {
  if (!command) {
    return [];
  }

  const matches = [];
  const invocationPattern = /(?:bun|npm|pnpm|yarn)(?:\s+run)?\s+([A-Za-z0-9:_-]+)/g;
  for (const match of command.matchAll(invocationPattern)) {
    const scriptName = match[1];
    if (scriptName && scripts?.[scriptName]) {
      matches.push(scriptName);
    }
  }
  return matches;
}

function scriptInvokesScript(entryScriptName, targetScriptName, scripts, seen = new Set()) {
  if (entryScriptName === targetScriptName) {
    return true;
  }
  if (seen.has(entryScriptName)) {
    return false;
  }
  seen.add(entryScriptName);

  const command = normalizeWhitespace(scripts?.[entryScriptName] ?? "");
  if (!command) {
    return false;
  }
  if (scriptReferencesScript(command, targetScriptName)) {
    return true;
  }

  for (const referencedScriptName of getReferencedScriptNames(command, scripts)) {
    if (
      referencedScriptName !== entryScriptName &&
      scriptInvokesScript(referencedScriptName, targetScriptName, scripts, seen)
    ) {
      return true;
    }
  }

  return false;
}

function collectScriptsToRun(scripts) {
  const scriptNames = [];
  const seenCommands = new Set();

  if (scripts.test) {
    const resolvedTestCommand = resolveScriptCommand("test", scripts) || normalizeWhitespace(scripts.test);
    scriptNames.push("test");
    if (resolvedTestCommand) {
      seenCommands.add(resolvedTestCommand);
    }
  }

  for (const scriptName of EXTRA_SCRIPT_NAMES) {
    const raw = normalizeWhitespace(scripts[scriptName] ?? "");
    if (!raw) {
      continue;
    }

    if (scriptInvokesScript("test", scriptName, scripts)) {
      continue;
    }

    const resolved = resolveScriptCommand(scriptName, scripts) || raw;
    if (seenCommands.has(resolved)) {
      continue;
    }

    scriptNames.push(scriptName);
    seenCommands.add(resolved);
  }

  return scriptNames;
}

function appendCapturedOutput(current, chunk) {
  const next = `${current}${chunk}`;
  if (next.length <= MAX_CAPTURED_OUTPUT_CHARS) {
    return next;
  }
  return next.slice(-MAX_CAPTURED_OUTPUT_CHARS);
}

function outputIndicatesNoTests(output) {
  return NO_TEST_OUTPUT_PATTERNS.some((pattern) => pattern.test(output));
}

function runScript(cwd, scriptName, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(bunCmd, ["run", scriptName], {
      cwd,
      env: {
        ...process.env,
        NODE_NO_WARNINGS: process.env.NODE_NO_WARNINGS || "1",
        MILADY_LIVE_TEST: process.env.MILADY_LIVE_TEST || "1",
        ELIZA_LIVE_TEST: process.env.ELIZA_LIVE_TEST || "1",
        PWD: cwd,
      },
      stdio: ["inherit", "pipe", "pipe"],
    });
    let capturedOutput = "";

    child.stdout?.on("data", (chunk) => {
      process.stdout.write(chunk);
      capturedOutput = appendCapturedOutput(
        capturedOutput,
        chunk.toString("utf8"),
      );
    });
    child.stderr?.on("data", (chunk) => {
      process.stderr.write(chunk);
      capturedOutput = appendCapturedOutput(
        capturedOutput,
        chunk.toString("utf8"),
      );
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve({ skipped: false });
        return;
      }
      if (outputIndicatesNoTests(capturedOutput)) {
        resolve({ skipped: true });
        return;
      }
      reject(
        new Error(
          `${label} failed with ${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`}`,
        ),
      );
    });
  });
}

ensurePluginSqlPostgresEnv();

const packageJsonPaths = collectPackageJsonPaths();

let started = startAt.length === 0;

for (const packageJsonPath of packageJsonPaths) {
  const cwd = path.dirname(packageJsonPath);
  const relativeDir = path.relative(repoRoot, cwd) || ".";
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const scripts = packageJson.scripts ?? {};
  const scriptNames = collectScriptsToRun(scripts);

  if (scriptNames.length === 0) {
    continue;
  }

  const packageLabel = packageJson.name || relativeDir;
  for (const scriptName of scriptNames) {
    const label = `${packageLabel} (${relativeDir})#${scriptName}`;
    if (!started) {
      if (label.includes(startAt)) {
        started = true;
      } else {
        continue;
      }
    }
    if (packageFilter && !packageFilter.test(label)) {
      continue;
    }
    if (scriptFilter && !scriptFilter.test(scriptName)) {
      continue;
    }
    console.log(`[eliza-test] START ${label}`);
    const startedAt = Date.now();
    const result = await runScript(cwd, scriptName, label);
    const durationMs = Date.now() - startedAt;
    if (result.skipped) {
      console.log(
        `[eliza-test] SKIP ${label} (${durationMs}ms, no test files found)`,
      );
      continue;
    }
    console.log(`[eliza-test] PASS ${label} (${durationMs}ms)`);
  }
}
