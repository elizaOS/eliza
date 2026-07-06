#!/usr/bin/env node
/**
 * Layered .env resolution for the LifeOps HITL credential tooling (#11632).
 * Credentials can live in four places on an operator machine, and this module
 * is the single arbiter of which one wins: process.env > the checkout's own
 * .env > the main checkout's .env (only when running inside a linked git
 * worktree — discovered via `git rev-parse --git-common-dir`) > ~/.eliza/.env.
 * The HITL dashboard and lane drivers consume loadLayeredEnv()/listPresent()
 * so a probe sees the same value a paste-and-save produced, no matter which
 * worktree the operator happens to be in.
 *
 * Saves default to ~/.eliza/.env — the layer that survives worktree churn —
 * with repo .env as the per-save alternative; writes are atomic (tmp file
 * mode 600 + rename) and preserve unrelated lines and comments. The parse,
 * merge, and upsert primitives are exported separately so they stay
 * unit-testable without touching the real filesystem or git. Values returned
 * by loadLayeredEnv are real secrets: callers must never render them — the
 * display-safe surface is listPresent(), which only reports presence and the
 * winning source layer.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);

/** Home-layer file: shared across every checkout and worktree of this repo. */
export const HOME_ENV_PATH = join(homedir(), ".eliza", ".env");

/** Precedence order, highest first; the values of the `sources` map. */
export const ENV_LAYER_SOURCES = ["process", "repo", "main", "home"];

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// --- pure primitives ---------------------------------------------------------

/**
 * Parse dotenv text: KEY=value with optional `export ` prefix, surrounding
 * single/double quotes stripped, comments and malformed lines skipped.
 * Identical semantics to the v1 dashboard parser so a file written by either
 * tool reads back the same.
 */
export function parseDotenv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      trimmed,
    );
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

/**
 * Merge layers ordered highest-precedence first; the first layer that defines
 * a key wins. "Defined" means a string value — including the empty string, so
 * an exported-but-empty process.env variable shadows a file value exactly like
 * dotenv's override:false behavior.
 */
export function mergeEnvLayers(layers) {
  const values = {};
  const sources = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer.values)) {
      if (typeof value !== "string") continue;
      if (Object.hasOwn(sources, key)) continue;
      values[key] = value;
      sources[key] = layer.source;
    }
  }
  return { values, sources };
}

/**
 * Replace KEY=value lines in dotenv text, preserving unrelated lines and
 * comments, appending keys that were not present. Always ends with a single
 * trailing newline.
 */
export function upsertEnvContent(existingText, entries) {
  const lines = existingText.length > 0 ? existingText.split("\n") : [];
  const remaining = new Map(Object.entries(entries));
  const nextLines = lines.map((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match && remaining.has(match[1])) {
      const value = remaining.get(match[1]);
      remaining.delete(match[1]);
      return `${match[1]}=${value}`;
    }
    return line;
  });
  while (
    nextLines.length > 0 &&
    nextLines[nextLines.length - 1].trim() === ""
  ) {
    nextLines.pop();
  }
  for (const [key, value] of remaining) nextLines.push(`${key}=${value}`);
  return `${nextLines.join("\n")}\n`;
}

/**
 * Decide whether a checkout is a linked git worktree from the raw
 * `git rev-parse --git-dir --git-common-dir` outputs. In a linked worktree the
 * git dir is `<main>/.git/worktrees/<name>` while the common dir is
 * `<main>/.git`, so when the two resolve differently the main checkout root is
 * the parent of the common dir. In the main checkout both resolve to the same
 * `.git`, and this returns null (the "main" layer is simply absent).
 */
export function resolveMainCheckoutRoot({
  gitDir,
  gitCommonDir,
  worktreeRoot,
}) {
  if (!gitDir || !gitCommonDir) return null;
  const resolvedGitDir = resolve(worktreeRoot, gitDir);
  const resolvedCommonDir = resolve(worktreeRoot, gitCommonDir);
  if (resolvedGitDir === resolvedCommonDir) return null;
  return dirname(resolvedCommonDir);
}

// --- filesystem/git boundary ---------------------------------------------------

/**
 * Discover the main checkout root for a linked worktree, or null when the
 * directory is the main checkout itself or not a git checkout at all. rev-parse
 * failures (git missing, not a repo) intentionally read as "no main layer"
 * rather than an error: the layered load degrades to repo + home.
 */
export function discoverMainCheckoutRoot(worktreeRoot = ROOT) {
  const result = spawnSync(
    "git",
    ["rev-parse", "--git-dir", "--git-common-dir"],
    {
      cwd: worktreeRoot,
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  if (result.error || result.status !== 0) return null;
  const [gitDir, gitCommonDir] = result.stdout.trim().split(/\r?\n/);
  return resolveMainCheckoutRoot({ gitDir, gitCommonDir, worktreeRoot });
}

/**
 * Load and merge every env layer. Returns:
 *   values  — merged KEY -> value (real secrets; never render these),
 *   sources — KEY -> 'process' | 'repo' | 'main' | 'home' (winning layer),
 *   layers  — [{ source, path, exists }] for display ("loaded from ...").
 * All roots/paths are injectable for tests; by default the repo root is this
 * checkout and the main root is git-discovered.
 */
export function loadLayeredEnv(options = {}) {
  const {
    processEnv = process.env,
    repoRoot = ROOT,
    homeEnvPath = HOME_ENV_PATH,
    mainRoot = discoverMainCheckoutRoot(options.repoRoot ?? ROOT),
  } = options;
  const filePaths = [];
  const pushUnique = (source, path) => {
    if (path && !filePaths.some((layer) => layer.path === path)) {
      filePaths.push({ source, path });
    }
  };
  pushUnique("repo", join(repoRoot, ".env"));
  if (mainRoot && resolve(mainRoot) !== resolve(repoRoot)) {
    pushUnique("main", join(mainRoot, ".env"));
  }
  pushUnique("home", homeEnvPath);
  const layers = [
    { source: "process", path: null, exists: true, values: processEnv },
    ...filePaths.map(({ source, path }) => {
      const exists = existsSync(path);
      return {
        source,
        path,
        exists,
        values: exists ? parseDotenv(readFileSync(path, "utf8")) : {},
      };
    }),
  ];
  const { values, sources } = mergeEnvLayers(layers);
  return {
    values,
    sources,
    layers: layers.map(({ source, path, exists }) => ({
      source,
      path,
      exists,
    })),
  };
}

/**
 * Load the layered env and fill process.env with every file-layer value whose
 * key the process does not already define. The lane driver and status
 * collector call this once at startup so their own readiness checks AND the
 * test suites they spawn observe exactly the resolution the dashboard
 * displays; the dashboard itself never calls this (it keeps process.env
 * pristine and reads the merged map instead). Returns the loadLayeredEnv
 * result for layer display.
 */
export function applyLayeredEnvToProcess(options = {}) {
  const loaded = loadLayeredEnv(options);
  const processEnv = options.processEnv ?? process.env;
  for (const [key, value] of Object.entries(loaded.values)) {
    if (processEnv[key] === undefined) processEnv[key] = value;
  }
  return loaded;
}

/**
 * Display-safe presence report for the given env names: present means a
 * non-empty value after trimming; source is the winning layer (attributed even
 * for empty-but-defined values, null when no layer defines the key). Never
 * returns values.
 */
export function listPresent(names, options = {}) {
  const { values, sources } = loadLayeredEnv(options);
  return names.map((name) => {
    const value = values[name];
    return {
      name,
      present: typeof value === "string" && value.trim().length > 0,
      source: sources[name] ?? null,
    };
  });
}

function atomicWriteEnvFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  // Mode 600 on the tmp file carries through the rename, so the final file is
  // owner-only even when it replaces a pre-existing looser one.
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Upsert one KEY=value into the chosen layer file — 'home' (~/.eliza/.env,
 * created on first save; the default because it survives worktree churn) or
 * 'repo' (this checkout's .env). Atomic tmp+rename write, mode 600. Also sets
 * the key on processEnv so probes running in the same process observe the save
 * immediately. Values must be single-line; multi-line values would corrupt the
 * dotenv format and are rejected.
 */
export function saveEnvVar(key, value, target = "home", options = {}) {
  const {
    repoRoot = ROOT,
    homeEnvPath = HOME_ENV_PATH,
    processEnv = process.env,
  } = options;
  if (typeof key !== "string" || !ENV_KEY_PATTERN.test(key)) {
    throw new Error(`saveEnvVar: invalid env key ${JSON.stringify(key)}`);
  }
  if (typeof value !== "string" || /[\r\n]/.test(value)) {
    throw new Error(`saveEnvVar(${key}): value must be a single-line string`);
  }
  if (target !== "home" && target !== "repo") {
    throw new Error(
      `saveEnvVar(${key}): target must be "home" or "repo", got ${JSON.stringify(target)}`,
    );
  }
  const path = target === "home" ? homeEnvPath : join(repoRoot, ".env");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  atomicWriteEnvFile(path, upsertEnvContent(existing, { [key]: value }));
  processEnv[key] = value;
  return { key, target, path };
}

// --- CLI: presence/source inspection (never prints values) -------------------

const IS_MAIN =
  import.meta.main || process.argv[1] === fileURLToPath(import.meta.url);

if (IS_MAIN) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const names = args.filter((arg) => !arg.startsWith("--"));
  const { layers } = loadLayeredEnv();
  const rows = names.length > 0 ? listPresent(names) : [];
  if (json) {
    console.log(JSON.stringify({ layers, present: rows }, null, 2));
  } else {
    for (const layer of layers) {
      console.log(
        `${layer.source.padEnd(8)} ${layer.path ?? "(process.env)"}${layer.exists ? "" : " (absent)"}`,
      );
    }
    for (const row of rows) {
      console.log(
        `${row.present ? "present" : "absent "} [${row.source ?? "-"}] ${row.name}`,
      );
    }
  }
}
