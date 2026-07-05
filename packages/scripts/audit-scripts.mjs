#!/usr/bin/env node
/**
 * Guard against the root `package.json` scripts block becoming a dumping ground
 * again (issue #9942). Scans package.json scripts and fails CI when it finds:
 *
 *   (a) ORPHAN root scripts — a root-package.json script that nothing invokes
 *       (no reference in .github/workflows/**, in any other script body, or in
 *       the docs / scripts source) AND that is not a recognised human/CI
 *       entrypoint. New scripts dumped into an ad-hoc namespace, or left behind
 *       after the tool they wrapped was deleted, get caught here.
 *
 *   (b) FAKE-SUCCESS no-ops — a `lint` / `typecheck` / `test` / `build` script
 *       whose body is just `echo "...skip..."`. Those report success while
 *       running nothing, so real lint/type/test/build failures land green.
 *
 *   (c) BROKEN references — a root script whose `--cwd <dir>` does not exist, or
 *       that points `node`/`bun` at a repo file (`*.mjs/.ts/.js/...`) that is
 *       missing. Deleting a tool without deleting its root alias is caught here.
 *
 *   (e) UNJUSTIFIED 1:1 package wrappers — a root script whose entire body is
 *       exactly `bun run --cwd <dir> <script>`. These are allowed only when the
 *       root command is a deliberate cross-package product or CI entrypoint and
 *       is documented below with a reason.
 *
 * Scope:
 *   - (a) orphan: the root package.json scripts block (the dumping ground).
 *   - (b) no-op: first-party shipping packages — root + packages/, plugins/,
 *     apps/ — minus the vendored/demo/scaffold subtrees packages/examples/**,
 *     packages/feed/**, packages/benchmarks/** and packages/elizaos/templates/**,
 *     which legitimately ship `echo "no toolchain; skipping"` placeholders.
 *   - (c) broken refs: the root scripts block only. Sub-package script paths are
 *     out of scope — the tree holds scaffolding templates and optional nested
 *     local-mode `eliza/` clone paths that are intentionally absent here.
 *
 * Usage:
 *   node packages/scripts/audit-scripts.mjs            # audit the repo, exit 1 on failure
 *   node packages/scripts/audit-scripts.mjs --json     # machine-readable findings
 *   node packages/scripts/audit-scripts.mjs --root DIR # audit a fixture tree (self-test)
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

/**
 * Root-script namespaces (first `:`-segment) that are legitimate human / CI /
 * release entrypoints. Scripts in these namespaces never need an automated
 * caller. `audit` and `lint` are deliberately absent: those namespaces are the
 * historical dumping ground, so every `audit:*` / `lint:*` root script must be
 * either referenced or an explicit entrypoint below.
 */
const ALLOWED_NAMESPACES = new Set([
  "dev",
  "build",
  "test",
  "bench",
  "db",
  "cloud",
  "release",
  "version",
  "prepublish",
  "postpublish",
  "publish",
  "format",
  "clean",
  "start",
  "verify",
  "knip",
  "soc2",
  "sync",
  "cache",
  "harness",
  "migrate",
  "generate",
  "voice",
  "voice-models",
  "eliza1",
  "local-inference",
  "personality",
  "lifeops",
  "ai-qa",
  "fix-deps",
  "trajectory",
  "ensure-plugin-test-conventions",
  "capability-router",
  "browser-bridge",
]);

/**
 * Bare day-to-day entrypoints (and this audit's own scripts) that are run by
 * hand and need no caller. Keep this list small.
 */
const ALLOWED_EXACT = new Set([
  "dev",
  "build",
  "verify",
  "check",
  "test",
  "lint",
  "lint:check",
  "format",
  "typecheck",
  "start",
  "clean",
  "reset",
  "knip",
  "pre-commit",
  "audit:scripts",
  "audit:scripts:self-test",
  "audit:tee-secret-leak",
  "audit:test-realness:evidence",
  "audit:scripts:inventory",
  "audit:type-duplication:self-test",
  "audit:tee-secret-leak:self-test",
  "audit:alias-read-guard:self-test",
]);

/**
 * (d) ORPHAN script files inside packages/scripts/ — a `.mjs` referenced by
 * nothing (no root alias, no CI workflow, no docs, no other reachable script).
 * This is the file-level twin of the root-script orphan check and stops the
 * report-builder slop cluster (issue #10194) from silently regrowing.
 *
 * Allowlist: standalone diagnostic / guard utilities that are intentionally run
 * by hand and need no automated caller. Each entry carries a written reason.
 */
const ORPHAN_SCRIPT_FILE_ALLOWLIST = new Map([
  [
    "audit-bin-export-subpaths.mjs",
    "static guard for the #8000 bin/exports bug class; run by hand during release review",
  ],
  [
    "benchmark-to-training-dataset.mjs",
    "one-shot benchmark→training-dataset converter, invoked manually with explicit paths",
  ],
  [
    "check-i18n.mjs",
    "strict i18n linter run on demand; not yet wired into verify",
  ],
  [
    "check-secret-hygiene.mjs",
    "standalone secret-hygiene scanner run by hand / in ad-hoc security sweeps",
  ],
  [
    "dev-health-check.mjs",
    "interactive dev-stack smoke launcher run by hand during local debugging",
  ],
  ["triage-tests.mjs", "human-run test-stack triage report generator"],
  [
    "run-live-test-with-artifacts.mjs",
    "standalone live-test runner (writes gitignored reports/live-test-runs); the producer that check-live-test-artifact-coverage.mjs validates",
  ],
]);

const ROOT_CWD_WRAPPER_ALLOWLIST = new Map([
  [
    "audit:apple-store-sandbox",
    "root audit entrypoint for the app-core Apple Store sandbox gate",
  ],
  ["start", "day-to-day root start entrypoint for the runnable agent"],
  ["dev:agent", "day-to-day root agent dev entrypoint"],
  ["dev:core", "day-to-day root core dev entrypoint"],
  ["test:hmr", "root release/regression gate for app HMR behavior"],
  [
    "test:desktop:packaged",
    "root release/regression gate for packaged desktop app startup behavior",
  ],
  [
    "test:desktop:packaged:windows",
    "root release/regression gate for the packaged Windows desktop smoke lane",
  ],
  [
    "test:apple-entitlements",
    "root release/regression gate for app entitlement checks",
  ],
  [
    "test:remote-capabilities",
    "remote-capabilities CI suite with root-level naming family",
  ],
  [
    "test:remote-capabilities:ui",
    "remote-capabilities CI suite with root-level naming family",
  ],
  [
    "test:remote-capabilities:source-build",
    "remote-capabilities CI suite with root-level naming family",
  ],
  [
    "test:remote-capabilities:docker",
    "remote-capabilities CI suite with root-level naming family",
  ],
  ["dev:cloud:api", "cloud API developer entrypoint"],
  ["dev:cloud:web", "cloud web developer entrypoint"],
  ["build:cloud", "cloud API build entrypoint"],
  ["test:cloud:e2e", "cloud API E2E entrypoint"],
  ["cloud:e2e", "cloud E2E package entrypoint"],
  ["cloud:e2e:headed", "cloud E2E headed mode entrypoint"],
  ["cloud:e2e:ui", "cloud E2E UI mode entrypoint"],
  [
    "bench:personality:calibrate",
    "personality benchmark calibration entrypoint",
  ],
  ["bench:eliza-1", "benchmark suite root entrypoint"],
  ["bench:recall", "benchmark suite root entrypoint"],
  ["bench:recall:1k", "benchmark suite root entrypoint"],
  ["bench:three-agent", "benchmark suite root entrypoint"],
  ["bench:three-agent:smoke", "benchmark suite root entrypoint"],
  ["db:cloud:generate", "cloud shared database root entrypoint"],
  ["db:cloud:studio", "cloud shared database root entrypoint"],
]);

const NOOP_GATE_KEYS = /^(lint|typecheck|test|build)(:|$)/;
// Demo / vendored / scaffold subtrees that legitimately ship placeholder scripts
// or reference paths that only exist after scaffolding. Out of the no-op gate.
const EXCLUDED_SUBTREES = [
  "packages/examples",
  "packages/feed",
  "packages/benchmarks",
  "packages/elizaos/templates",
];
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

/** Text corpus used to decide whether a root script name is referenced. */
function buildReferenceCorpus(root) {
  const chunks = [];
  walk(path.join(root, ".github", "workflows"), (file) => {
    if (/\.(ya?ml)$/.test(file)) chunks.push(readTextIfReadable(file));
  });
  // Every package.json's script bodies (no exclusions — broad reference coverage).
  const seenPkg = new Set([path.join(root, "package.json")]);
  for (const base of ["packages", "plugins", "apps"]) {
    walk(path.join(root, base), (file) => {
      if (path.basename(file) === "package.json") seenPkg.add(file);
    });
  }
  for (const file of seenPkg) {
    if (!existsSync(file)) continue;
    const scripts = readJson(file).scripts;
    if (scripts) chunks.push(Object.values(scripts).join("\n"));
  }
  for (const base of ["docs", "packages", "plugins", "apps", ".github"]) {
    walk(path.join(root, base), (file) => {
      if (file.endsWith(".md")) chunks.push(readTextIfReadable(file));
    });
  }
  walk(path.join(root, "scripts"), (file) => {
    if (/\.(mjs|cjs|js|ts|mts|cts)$/.test(file))
      chunks.push(readTextIfReadable(file));
  });
  walk(path.join(root, "packages", "scripts"), (file) => {
    if (/\.(mjs|cjs|js|ts|mts|cts)$/.test(file))
      chunks.push(readTextIfReadable(file));
  });
  // Root-level docs (README, AGENTS, CLAUDE, …) without recursing into packages.
  for (const entry of readdirSync(root)) {
    if (entry.endsWith(".md"))
      chunks.push(readTextIfReadable(path.join(root, entry)));
  }
  return chunks.join("\n");
}

function namespaceOf(name) {
  const idx = name.indexOf(":");
  return idx === -1 ? name : name.slice(0, idx);
}

function exactCwdWrapper(body) {
  const match = body.match(/^bun\s+run\s+--cwd\s+(\S+)\s+(\S+)$/);
  if (!match) return null;
  return {
    cwd: match[1].replace(/^["']|["']$/g, ""),
    script: match[2].replace(/^["']|["']$/g, ""),
  };
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

/**
 * Reference corpus for the packages/scripts file-orphan check (d). Unlike
 * buildReferenceCorpus it excludes the packages/scripts source itself; cross
 * references between script files are evaluated per-file (excluding a file's own
 * body) so a script naming itself in a usage comment does not look "referenced".
 */
function buildNonScriptCorpus(root) {
  const chunks = [];
  walk(path.join(root, ".github", "workflows"), (file) => {
    if (/\.(ya?ml)$/.test(file)) chunks.push(readTextIfReadable(file));
  });
  const seenPkg = new Set([path.join(root, "package.json")]);
  for (const base of ["packages", "plugins", "apps"]) {
    walk(path.join(root, base), (file) => {
      if (path.basename(file) === "package.json") seenPkg.add(file);
    });
  }
  for (const file of seenPkg) {
    if (!existsSync(file)) continue;
    const scripts = readJson(file).scripts;
    if (scripts) chunks.push(Object.values(scripts).join("\n"));
  }
  for (const base of ["docs", "packages", "plugins", "apps", ".github"]) {
    walk(path.join(root, base), (file) => {
      if (file.endsWith(".md")) chunks.push(readTextIfReadable(file));
    });
  }
  walk(path.join(root, "scripts"), (file) => {
    if (/\.(mjs|cjs|js|ts|mts|cts)$/.test(file))
      chunks.push(readTextIfReadable(file));
  });
  return chunks.join("\n");
}

/** Flag packages/scripts/*.mjs that nothing references (issue #10194). */
function auditScriptFiles(root) {
  const dir = path.join(root, "packages", "scripts");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((name) => name.endsWith(".mjs"));
  const bodies = new Map(
    files.map((name) => [name, readTextIfReadable(path.join(dir, name))]),
  );
  const nonScriptCorpus = buildNonScriptCorpus(root);

  const failures = [];
  for (const name of files) {
    if (ORPHAN_SCRIPT_FILE_ALLOWLIST.has(name)) continue;
    if (nonScriptCorpus.includes(name)) continue;
    // Referenced by any OTHER script file (spawn/exec/import/string mention)?
    const referencedBySibling = files.some(
      (other) => other !== name && bodies.get(other).includes(name),
    );
    if (referencedBySibling) continue;
    failures.push(
      `[orphan-file] packages/scripts/${name} is referenced by nothing (no ` +
        `root script, CI workflow, docs, or other reachable script). Wire it ` +
        `to a caller, add it to ORPHAN_SCRIPT_FILE_ALLOWLIST with a reason, or ` +
        `delete it.`,
    );
  }
  return failures;
}

// Directories the plugin-coupling check scans for generic scripts. Both trees
// hold plugin-agnostic build/test/dev automation that must discover plugins via
// the shared seam + per-package metadata, not by naming plugin sets inline.
const PLUGIN_COUPLING_SCAN_DIRS = ["scripts", path.join("packages", "scripts")];
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
  const corpus = buildReferenceCorpus(root);
  const rootScripts = readJson(path.join(root, "package.json")).scripts ?? {};

  // (a) Orphan root scripts.
  for (const name of Object.keys(rootScripts)) {
    if (ALLOWED_EXACT.has(name)) continue;
    if (ALLOWED_NAMESPACES.has(namespaceOf(name))) continue;
    if (corpus.includes(name)) continue;
    failures.push(
      `[orphan] root script "${name}" is never referenced (workflows, other ` +
        `script bodies, docs) and is not a recognised entrypoint. Wire it to a ` +
        `caller, add it to the audit allowlist, or delete it.`,
    );
  }

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

    const wrapper = exactCwdWrapper(body);
    if (wrapper && !ROOT_CWD_WRAPPER_ALLOWLIST.has(name)) {
      failures.push(
        `[cwd-wrapper] root script "${name}" is a 1:1 package wrapper ` +
          `(${JSON.stringify(body)}). Call "bun run --cwd ${wrapper.cwd} ` +
          `${wrapper.script}" directly, or add an explicit allowlist reason.`,
      );
    }

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

  // (d) Orphan script files inside packages/scripts/.
  failures.push(...auditScriptFiles(root));

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
      "[audit-scripts] OK — no orphan/no-op/broken scripts.\n",
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

if (import.meta.url === `file://${process.argv[1]}`) main();
