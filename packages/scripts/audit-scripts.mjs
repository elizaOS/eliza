#!/usr/bin/env node
/**
 * Validates executable script targets and rejects fake-success package gates.
 * Manual commands do not require callers; lexical references and namespaces
 * cannot establish whether a tool is needed. Plugin-independent infrastructure
 * must still discover capabilities through package metadata.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

const NOOP_GATE_KEYS = /^(lint|typecheck|test|build)(:|$)/;
// Demo / vendored / scaffold subtrees that legitimately ship placeholder scripts
// or reference paths that only exist after scaffolding. Out of the no-op gate.
const EXCLUDED_SUBTREES = ["packages/elizaos/templates"];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".turbo",
  ".git",
  "coverage",
  "build",
  "out",
]);
const FILE_TOKEN = /\.(mjs|cjs|js|mts|cts|ts|tsx)$/;

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function readTextIfReadable(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function isExcluded(relPath) {
  const norm = relPath.split(path.sep).join("/");
  return EXCLUDED_SUBTREES.some(
    (sub) => norm === sub || norm.startsWith(`${sub}/`),
  );
}

function walk(dir, visit) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else visit(full);
  }
}

/** Every first-party package.json (root + packages/plugins/apps, minus demos). */
function collectPackageJsons(root) {
  const found = [path.join(root, "package.json")];
  for (const base of ["packages", "plugins", "apps"]) {
    walk(path.join(root, base), (file) => {
      if (path.basename(file) !== "package.json") return;
      if (isExcluded(path.relative(root, file))) return;
      found.push(file);
    });
  }
  return found.filter(existsSync);
}

function isNoopSkip(body) {
  if (!/skip/i.test(body) || !/\becho\b/i.test(body)) return false;
  const segments = body
    .split(/&&|\|\||;/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  // A genuine guard runs a real command alongside the echo; a no-op is echo only.
  return segments.every((segment) => /^echo\b/i.test(segment));
}

/** Candidate repo-relative file tokens referenced by a script body. */
function fileTokens(body) {
  return body
    .split(/\s+/)
    .map((token) => token.replace(/^["']|["']$/g, ""))
    .filter(
      (token) =>
        token.includes("/") && FILE_TOKEN.test(token) && !/[*${}]/.test(token),
    );
}

function existsAsFileFrom(bases, token) {
  return bases.some((base) => {
    const resolved = path.resolve(base, token);
    return existsSync(resolved) && statSync(resolved).isFile();
  });
}

function existsAsDirFrom(bases, token) {
  return bases.some((base) => {
    const resolved = path.resolve(base, token);
    return existsSync(resolved) && statSync(resolved).isDirectory();
  });
}

// Directories the plugin-coupling check scans for generic scripts. Both trees
// hold plugin-agnostic build/test/dev automation that must discover plugins via
// the shared seam + per-package metadata, not by naming plugin sets inline.
const PLUGIN_COUPLING_SCAN_DIRS = [
  "scripts",
  path.join("packages", "scripts"),
  path.join("packages", "cloud", "scripts"),
];
const PLUGIN_COUPLING_FILE_TOKEN = /\.(mjs|cjs|js|mts|cts|ts|tsx)$/;
// A `plugins/plugin-<name>` or `@elizaos/plugin-<name>` literal hardcoded in a
// generic script. `<name>` is the package suffix; subpaths/quotes are trimmed by
// the capture so a token normalises to its bare package identity.
const PLUGIN_TOKEN_RE =
  /(?:plugins\/plugin-[a-z0-9][a-z0-9-]*|@elizaos\/plugin-[a-z0-9][a-z0-9-]*)/g;
const PLUGIN_COUPLING_ALLOWLIST_FILE = "script-plugin-coupling.allowlist.json";

// Files exempt from the coupling scan: tests + self-tests (they assert on
// plugin behavior by name), generated files, and the allowlist itself.
function isCouplingExemptFile(relPath) {
  const norm = relPath.split(path.sep).join("/");
  const base = path.basename(norm);
  return (
    /\.(test|self-test)\.[cm]?[jt]sx?$/.test(base) ||
    norm.includes("/__tests__/") ||
    /\.generated\./.test(base) ||
    base === PLUGIN_COUPLING_ALLOWLIST_FILE
  );
}

function readCouplingAllowlist(root) {
  const file = path.join(
    root,
    "packages",
    "scripts",
    PLUGIN_COUPLING_ALLOWLIST_FILE,
  );
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(
      `${PLUGIN_COUPLING_ALLOWLIST_FILE} must be a JSON array of { file, tokens, reason }`,
    );
  }
  return parsed;
}

/**
 * Distinct plugin tokens hardcoded in a file, sorted. Empty for a file that
 * discovers plugins through the shared seam instead of naming them.
 */
function pluginTokensInFile(absFile) {
  const matches = readTextIfReadable(absFile).match(PLUGIN_TOKEN_RE) ?? [];
  return [...new Set(matches)].sort((a, b) => a.localeCompare(b));
}

/**
 * (f) PLUGIN COUPLING — a generic build/test/dev script must not name a plugin
 * set inline; it discovers plugins through the shared workspace seam + per-package
 * `elizaos.scripts` metadata (#12334). A hardcoded `plugins/plugin-*` /
 * `@elizaos/plugin-*` token fails unless the file+token is allowlisted with a
 * reason in script-plugin-coupling.allowlist.json (systemic couplings only). A
 * stale allowlist entry — a listed file/token no longer present — also fails, so
 * the allowlist cannot rot into permanent cover.
 */
function auditPluginCoupling(root) {
  const failures = [];
  const allowlist = readCouplingAllowlist(root);

  // Index the allowlist by normalised repo-relative file → allowed token set.
  const allowByFile = new Map();
  for (const entry of allowlist) {
    if (
      !entry ||
      typeof entry.file !== "string" ||
      !Array.isArray(entry.tokens) ||
      typeof entry.reason !== "string" ||
      entry.reason.trim().length === 0
    ) {
      failures.push(
        `[coupling-allowlist] malformed entry ${JSON.stringify(entry)} — each ` +
          `entry needs { file: string, tokens: string[], reason: non-empty string }.`,
      );
      continue;
    }
    allowByFile.set(
      entry.file.split(path.sep).join("/"),
      new Set(entry.tokens),
    );
  }

  // Actual tokens present per scanned file.
  const tokensByFile = new Map();
  for (const scanDir of PLUGIN_COUPLING_SCAN_DIRS) {
    const base = path.join(root, scanDir);
    walk(base, (file) => {
      if (!PLUGIN_COUPLING_FILE_TOKEN.test(file)) return;
      const rel = path.relative(root, file).split(path.sep).join("/");
      if (isCouplingExemptFile(rel)) return;
      const tokens = pluginTokensInFile(file);
      if (tokens.length > 0) tokensByFile.set(rel, tokens);
    });
  }

  // Fail on hardcoded tokens not covered by an allowlist entry for that file.
  for (const [rel, tokens] of tokensByFile) {
    const allowed = allowByFile.get(rel) ?? new Set();
    const unallowed = tokens.filter((token) => !allowed.has(token));
    if (unallowed.length > 0) {
      failures.push(
        `[coupling] ${rel} hardcodes plugin token(s) ${JSON.stringify(unallowed)}. ` +
          `Discover plugins via the shared seam + per-package elizaos.scripts ` +
          `metadata, or add the file+token to ${PLUGIN_COUPLING_ALLOWLIST_FILE} ` +
          `with a systemic-coupling reason.`,
      );
    }
  }

  // Fail on stale allowlist entries — a listed file/token no longer present.
  for (const entry of allowlist) {
    if (!entry || typeof entry.file !== "string") continue;
    const rel = entry.file.split(path.sep).join("/");
    const present = tokensByFile.get(rel);
    if (!present) {
      failures.push(
        `[coupling-stale] ${PLUGIN_COUPLING_ALLOWLIST_FILE} allowlists "${rel}" ` +
          `but it has no plugin tokens (file removed or already decoupled). ` +
          `Drop the entry.`,
      );
      continue;
    }
    for (const token of entry.tokens ?? []) {
      if (!present.includes(token)) {
        failures.push(
          `[coupling-stale] ${PLUGIN_COUPLING_ALLOWLIST_FILE} allowlists token ` +
            `"${token}" for "${rel}" but it no longer appears there. Drop the token.`,
        );
      }
    }
  }

  return failures;
}

function auditScripts(root) {
  const failures = [];
  const rootScripts = readJson(path.join(root, "package.json")).scripts ?? {};

  // (b) Fake-success no-op lint/typecheck/test/build across first-party packages.
  for (const file of collectPackageJsons(root)) {
    const rel = path.relative(root, file) || "package.json";
    const scripts = readJson(file).scripts ?? {};
    for (const [name, body] of Object.entries(scripts)) {
      if (typeof body !== "string") continue;
      if (NOOP_GATE_KEYS.test(name) && isNoopSkip(body)) {
        failures.push(
          `[no-op] ${rel} script "${name}" is a fake-success echo-skip ` +
            `(${JSON.stringify(body)}). Run the real tool instead.`,
        );
      }
    }
  }

  // (c) Broken --cwd / file references in the root scripts block — the dumping
  // ground this audit guards. (Sub-package script paths are out of scope: the
  // tree legitimately holds scaffolding templates and optional nested-clone
  // `eliza/` references that are absent here.)
  for (const [name, body] of Object.entries(rootScripts)) {
    if (typeof body !== "string") continue;

    const cwdMatch = body.match(/--cwd\s+(\S+)/);
    if (cwdMatch) {
      const target = cwdMatch[1].replace(/^["']|["']$/g, "");
      if (!/[*${}]/.test(target) && !existsAsDirFrom([root], target)) {
        failures.push(
          `[broken-cwd] root script "${name}" uses --cwd "${target}" but that ` +
            `directory does not exist.`,
        );
      }
    }

    const hasCd = /\bcd\s+\S/.test(body);
    for (const token of fileTokens(body)) {
      const isRelative = token.startsWith("./") || token.startsWith("../");
      if (isRelative && hasCd) continue; // `cd X && node ../rel` shifts the cwd.
      if (token.startsWith("eliza/")) continue; // optional local-mode clone.
      if (!existsAsFileFrom([root], token)) {
        failures.push(
          `[broken-path] root script "${name}" references "${token}" but no ` +
            `such file exists.`,
        );
      }
    }
  }

  // (f) Plugin coupling — generic scripts must discover plugins, not name them.
  failures.push(...auditPluginCoupling(root));

  return failures;
}

function main() {
  const args = process.argv.slice(2);
  const rootArg = args.indexOf("--root");
  const root = rootArg === -1 ? DEFAULT_ROOT : path.resolve(args[rootArg + 1]);
  const json = args.includes("--json");

  const failures = auditScripts(root);

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: failures.length === 0, failures }, null, 2)}\n`,
    );
  } else if (failures.length === 0) {
    process.stdout.write(
      "[audit-scripts] OK — executable targets and package gates are valid.\n",
    );
  } else {
    process.stderr.write(
      `[audit-scripts] ${failures.length} finding(s):\n` +
        failures.map((f) => `  - ${f}`).join("\n") +
        "\n",
    );
  }

  process.exit(failures.length === 0 ? 0 : 1);
}

export { auditScripts };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
