#!/usr/bin/env node
/**
 * lint-test-integrity.mjs
 *
 * Whole-repo test-integrity gate for the "de-larp" mandate (issue #10718,
 * AGENTS.md law #2 — "test everything for real, no larp"). Complements
 * `lint-lane-coverage.mjs` (which checks *plugin-level* coverage): this gate
 * works at the individual test-call granularity and blocks the two silent
 * larp vectors that no existing check catches, plus an informational inventory
 * of never-run test files.
 *
 * Checks:
 *
 *   A. Exclusive tests [BLOCKING, no allowlist]
 *      `describe.only` / `it.only` / `test.only` / `bench.only` / `suite.only`
 *      and jasmine-style `fdescribe(` / `fit(`. A single `.only` silently drops
 *      every sibling test in its file while the suite still reports green, so
 *      the tree target is zero and there is no suppression path.
 *
 *   B. Orphaned declared skips [BLOCKING, ratchet allowlist]
 *      A *declared* skip — `describe.skip("title", fn)` / `it.skip("title", fn)`
 *      / `xit(...)` / `xdescribe(...)` — with a NON-EMPTY callback body is a real
 *      test whose assertions have been disabled. It must either link a tracking
 *      issue (a `#NNN` / issues URL in an adjacent comment or in the title) or be
 *      grandfathered in `lint-test-integrity.allowlist.json` with a written
 *      reason. New untracked orphaned skips fail the build; unused allowlist
 *      capacity fails too, so the debt ratchets down as skips are fixed.
 *
 *      NOT flagged (legitimate runtime gates): conditional skips
 *      `test.skip(cond, "reason")` (first arg is not a string literal),
 *      dynamic skips `test.skip("reason")` (no callback), and empty-body
 *      placeholder skips `it.skip("[live] …", () => {})` (the sanctioned idiom
 *      for signalling an env / platform / live-key gate in the report).
 *
 *   C. Never-run test files [INFORMATIONAL]
 *      `*.real.test.ts` / `*.real.e2e.test.ts` only execute in the `post-merge`
 *      lane (never in the default deterministic PR lane), and test files in
 *      packages with no `test` script are claimed by no lane at all. Reported
 *      as an inventory, not gated, because a hard gate needs full per-package
 *      vitest include/exclude evaluation and would be false-positive-prone.
 *
 * Usage:
 *   node packages/scripts/lint-test-integrity.mjs            # CI gate (exit 1 on violations)
 *   node packages/scripts/lint-test-integrity.mjs --dry-run  # inventory, always exit 0
 *   node packages/scripts/lint-test-integrity.mjs --json     # machine-readable result
 *   node packages/scripts/lint-test-integrity.mjs --write-allowlist  # (re)seed the ratchet allowlist
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(here, "..", "..");
const DEFAULT_ALLOWLIST_PATH = path.join(
  here,
  "lint-test-integrity.allowlist.json",
);

const SCAN_DIRS = ["packages", "plugins", "cloud"];
const SKIP_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

// Directories whose test files are fixtures/helpers for other test tooling and
// deliberately contain `.skip`/`.only` shaped strings or wrapper helpers.
const WHITELIST_SEGMENTS = [
  path.join("test", "mocks"),
  path.join("scripts", "__fixtures__"),
];

const TEST_FILE_RE = /\.(?:test|spec)\.(?:c|m)?[tj]sx?$/;
const REAL_FILE_RE = /\.real(?:\.e2e)?\.(?:test|spec)\.(?:c|m)?[tj]sx?$/;

const TEST_FRAMES = ["describe", "it", "test", "bench", "suite"];

// ---------------------------------------------------------------------------
// Source neutralisation
// ---------------------------------------------------------------------------

/**
 * Return a copy of `src` where the *contents* of comments and string/template
 * literals are replaced with a filler so that structural scanning (paren
 * matching, `.only(` / `.skip(` detection, empty-body detection) never trips on
 * text that lives inside a comment or string. Quotes and braces that delimit
 * the literals are preserved so the first-argument-is-a-string test still works,
 * and newline positions are preserved so reported line numbers stay accurate.
 *
 * Best-effort regex-literal handling avoids treating a `/…/` pattern's inner
 * quotes as string starts. This is a lexer-lite, not a full JS parser — it is
 * intentionally conservative and locked down by the self-test.
 */
export function neutralizeSource(src) {
  const out = new Array(src.length);
  let i = 0;
  const n = src.length;
  // Last significant (non-space, non-comment) code char — used to disambiguate
  // a leading `/` as regex-literal vs division.
  let lastSignificant = "";

  const pushChar = (ch, replacement) => {
    out[i] = replacement === undefined ? ch : replacement;
  };

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    // Line comment
    if (ch === "/" && next === "/") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      while (i < n && src[i] !== "\n") {
        out[i] = " ";
        i++;
      }
      continue;
    }

    // Block comment
    if (ch === "/" && next === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out[i] = src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
      }
      continue;
    }

    // String / template literal
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out[i] = ch; // keep the opening quote
      i++;
      while (i < n) {
        const c = src[i];
        if (c === "\\") {
          out[i] = "x";
          if (i + 1 < n) out[i + 1] = src[i + 1] === "\n" ? "\n" : "x";
          i += 2;
          continue;
        }
        if (c === quote) {
          out[i] = c; // keep the closing quote
          i++;
          break;
        }
        out[i] = c === "\n" ? "\n" : "x";
        i++;
      }
      lastSignificant = quote;
      continue;
    }

    // Regex literal (best effort): a `/` in expression position.
    if (ch === "/" && isRegexStart(lastSignificant)) {
      out[i] = " ";
      i++;
      let inClass = false;
      while (i < n) {
        const c = src[i];
        if (c === "\\") {
          out[i] = " ";
          if (i + 1 < n) out[i + 1] = src[i + 1] === "\n" ? "\n" : " ";
          i += 2;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) {
          out[i] = " ";
          i++;
          break;
        } else if (c === "\n") {
          // Unterminated regex — bail, treat the `/` as division after all.
          break;
        }
        out[i] = " ";
        i++;
      }
      lastSignificant = "/";
      continue;
    }

    pushChar(ch);
    if (!/\s/.test(ch)) lastSignificant = ch;
    i++;
  }

  return out.join("");
}

function isRegexStart(lastSignificant) {
  if (lastSignificant === "") return true;
  // After these tokens a `/` begins a regex; after an identifier char, `)`, `]`
  // or a number it is division.
  return "([{,;=:?&|!+-*%^~<>".includes(lastSignificant);
}

// ---------------------------------------------------------------------------
// Structural scanning helpers
// ---------------------------------------------------------------------------

function lineOf(text, index) {
  let line = 1;
  for (let k = 0; k < index && k < text.length; k++) {
    if (text[k] === "\n") line++;
  }
  return line;
}

/** Index of the char after the whitespace run starting at `from`. */
function skipWs(text, from) {
  let k = from;
  while (k < text.length && /\s/.test(text[k])) k++;
  return k;
}

/** Given index of an opening `(`/`{`/`[`, return the index of its match (or -1). */
function matchBracket(neutralized, openIdx) {
  const open = neutralized[openIdx];
  const close = open === "(" ? ")" : open === "{" ? "}" : "]";
  let depth = 0;
  for (let k = openIdx; k < neutralized.length; k++) {
    const c = neutralized[k];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

const EXCLUSIVE_RE = new RegExp(
  `(?:(?<![.\\w])(?:${TEST_FRAMES.join("|")})\\s*\\.\\s*only\\s*\\(|(?<![.\\w])(?:fdescribe|fit|ftest)\\s*\\()`,
  "g",
);

const DECLARED_SKIP_RE = new RegExp(
  `(?:(?<![.\\w])(?:${TEST_FRAMES.join("|")})\\s*\\.\\s*skip\\s*\\(|(?<![.\\w])(?:xdescribe|xit|xtest)\\s*\\()`,
  "g",
);

function findExclusives(neutralized, rawLines, relPath) {
  const hits = [];
  for (const m of neutralized.matchAll(EXCLUSIVE_RE)) {
    const line = lineOf(neutralized, m.index);
    hits.push({
      file: relPath,
      line,
      snippet: (rawLines[line - 1] ?? "").trim().slice(0, 160),
    });
  }
  return hits;
}

/**
 * Locate the callback's `{ … }` body inside a call's argument region and report
 * whether it is empty (whitespace only). Returns null when there is no callback
 * body (dynamic single-arg skip).
 */
function callbackBodyIsEmpty(neutralized, argsOpenIdx, argsCloseIdx) {
  // Find `=> {` or `function (…) {` inside the args and test its body.
  const region = neutralized.slice(argsOpenIdx, argsCloseIdx + 1);
  const arrow = region.indexOf("=>");
  let braceSearchStart = -1;
  if (arrow !== -1) {
    braceSearchStart = argsOpenIdx + arrow + 2;
  } else {
    const fn = region.search(/\bfunction\b/);
    if (fn !== -1) braceSearchStart = argsOpenIdx + fn;
  }
  if (braceSearchStart === -1) return null; // no callback → dynamic skip
  const braceIdx = neutralized.indexOf("{", braceSearchStart);
  if (braceIdx === -1 || braceIdx > argsCloseIdx) return null;
  const braceClose = matchBracket(neutralized, braceIdx);
  if (braceClose === -1) return null;
  const body = neutralized.slice(braceIdx + 1, braceClose);
  return body.trim().length === 0;
}

const TRACKING_RE = /#\d{3,}|\/issues\/\d+|ELIZA-\d+/;

function hasTrackingRef(rawLines, line, title) {
  if (TRACKING_RE.test(title)) return true;
  // Same line + up to 3 preceding lines (comment banner above the skip).
  const start = Math.max(0, line - 4);
  for (let k = start; k <= line - 1 && k < rawLines.length; k++) {
    if (TRACKING_RE.test(rawLines[k] ?? "")) return true;
  }
  return false;
}

function findDeclaredSkips(neutralized, raw, rawLines, relPath) {
  const results = [];
  for (const m of neutralized.matchAll(DECLARED_SKIP_RE)) {
    const openIdx = neutralized.indexOf("(", m.index + m[0].length - 1);
    if (openIdx === -1) continue;
    const closeIdx = matchBracket(neutralized, openIdx);
    if (closeIdx === -1) continue;

    const firstArgIdx = skipWs(neutralized, openIdx + 1);
    const firstChar = neutralized[firstArgIdx];
    const isStringTitle =
      firstChar === '"' || firstChar === "'" || firstChar === "`";
    if (!isStringTitle) continue; // conditional skip → legitimate

    const line = lineOf(neutralized, m.index);
    const emptyBody = callbackBodyIsEmpty(neutralized, openIdx, closeIdx);
    // emptyBody === null → no callback (dynamic single-arg skip) → legitimate.
    // emptyBody === true → placeholder runtime gate → legitimate.
    const isDisabledRealTest = emptyBody === false;

    // Read the real (un-neutralised) title text for a stable allowlist key.
    const titleClose = matchStringLiteral(raw, firstArgIdx);
    const title =
      titleClose === -1 ? "" : raw.slice(firstArgIdx + 1, titleClose);

    results.push({
      file: relPath,
      line,
      title,
      isDisabledRealTest,
      tracked: hasTrackingRef(rawLines, line, title),
      snippet: (rawLines[line - 1] ?? "").trim().slice(0, 160),
    });
  }
  return results;
}

/** Given the index of an opening quote in `raw`, return the closing-quote index. */
function matchStringLiteral(raw, quoteIdx) {
  const quote = raw[quoteIdx];
  for (let k = quoteIdx + 1; k < raw.length; k++) {
    if (raw[k] === "\\") {
      k++;
      continue;
    }
    if (raw[k] === quote) return k;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// File-system walk
// ---------------------------------------------------------------------------

function normalizeRepoPath(value) {
  return value.split(path.sep).join("/");
}

function isWhitelisted(repoRoot, filePath) {
  const rel = path.relative(repoRoot, filePath);
  return WHITELIST_SEGMENTS.some((seg) => rel.includes(seg));
}

function* walkTestFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkTestFiles(full);
    } else if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
      yield full;
    }
  }
}

/**
 * Whether ANY ancestor package.json (from the file up to the repo root) declares
 * a `test*` script. Used for the informational never-run inventory (check C).
 *
 * We deliberately check every ancestor, not just the nearest package.json: a
 * common layout puts a scriptless `src/package.json` next to the tests while the
 * real `test` script (`cd src && vitest run`) lives one level up. Requiring
 * *no* ancestor to run tests keeps this heuristic to a strong, low-false-
 * positive signal (it never gates the build, only reports).
 */
function anyAncestorHasTestScript(repoRoot, filePath, cache) {
  let dir = path.dirname(filePath);
  const stopAt = path.resolve(repoRoot);
  while (dir.startsWith(stopAt)) {
    let hasTest = cache.get(dir);
    if (hasTest === undefined) {
      hasTest = false;
      const pkgPath = path.join(dir, "package.json");
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
          hasTest = Object.keys(pkg.scripts ?? {}).some((k) =>
            k.startsWith("test"),
          );
        } catch {
          hasTest = false;
        }
      }
      cache.set(dir, hasTest);
    }
    if (hasTest) return true;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false; // no ancestor runs tests → genuinely unclaimed
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

function loadAllowlist(allowlistPath) {
  if (!allowlistPath || !fs.existsSync(allowlistPath)) {
    return { path: allowlistPath, byKey: new Map(), errors: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(allowlistPath, "utf8"));
  } catch (error) {
    return {
      path: allowlistPath,
      byKey: new Map(),
      errors: [`allowlist: failed to parse JSON (${error.message})`],
    };
  }
  const rawEntries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  const byKey = new Map();
  const errors = [];
  rawEntries.forEach((entry, index) => {
    const label = `allowlist: entry ${index + 1}`;
    if (!entry || typeof entry !== "object") {
      errors.push(`${label} must be an object`);
      return;
    }
    if (typeof entry.file !== "string" || !entry.file.trim()) {
      errors.push(`${label} must include a file`);
      return;
    }
    if (typeof entry.title !== "string") {
      errors.push(`${label} must include a title`);
      return;
    }
    if (typeof entry.reason !== "string" || !entry.reason.trim()) {
      errors.push(`${label} (${entry.file}) must include a non-empty reason`);
      return;
    }
    const count = Number.isInteger(entry.count) ? entry.count : 1;
    if (count < 1) {
      errors.push(`${label} (${entry.file}) count must be >= 1`);
      return;
    }
    const key = `${entry.file}::${entry.title}`;
    byKey.set(key, { ...entry, count, matched: 0 });
  });
  return { path: allowlistPath, byKey, errors };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export function analyzeTestIntegrity(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const allowlistPath =
    options.allowlistPath === null
      ? null
      : path.resolve(options.allowlistPath ?? DEFAULT_ALLOWLIST_PATH);
  const allowlist = loadAllowlist(allowlistPath);
  const pkgCache = new Map();

  const exclusives = [];
  const orphanedSkips = []; // disabled real test, untracked, not allowlisted
  const suppressedSkips = []; // disabled real test, allowlisted
  const trackedSkips = []; // disabled real test, has tracking ref
  const placeholderSkips = []; // empty-body / dynamic → informational
  const neverRunFiles = [];

  let scannedFiles = 0;

  for (const scanDir of SCAN_DIRS) {
    const absDir = path.join(repoRoot, scanDir);
    if (!fs.existsSync(absDir)) continue;
    for (const filePath of walkTestFiles(absDir)) {
      if (isWhitelisted(repoRoot, filePath)) continue;
      let raw;
      try {
        raw = fs.readFileSync(filePath, "utf8");
      } catch {
        continue;
      }
      scannedFiles++;
      const relPath = normalizeRepoPath(path.relative(repoRoot, filePath));
      const rawLines = raw.split("\n");
      const neutralized = neutralizeSource(raw);

      for (const hit of findExclusives(neutralized, rawLines, relPath)) {
        exclusives.push(hit);
      }

      for (const skip of findDeclaredSkips(
        neutralized,
        raw,
        rawLines,
        relPath,
      )) {
        if (!skip.isDisabledRealTest) {
          placeholderSkips.push(skip);
          continue;
        }
        if (skip.tracked) {
          trackedSkips.push(skip);
          continue;
        }
        const key = `${skip.file}::${skip.title}`;
        const entry = allowlist.byKey.get(key);
        if (entry && entry.matched < entry.count) {
          entry.matched++;
          suppressedSkips.push({ ...skip, reason: entry.reason });
        } else {
          orphanedSkips.push(skip);
        }
      }

      // Check C — informational never-run inventory.
      const base = path.basename(relPath);
      if (REAL_FILE_RE.test(base)) {
        neverRunFiles.push({
          file: relPath,
          reason: "post-merge-only (*.real)",
        });
      } else if (!anyAncestorHasTestScript(repoRoot, filePath, pkgCache)) {
        neverRunFiles.push({
          file: relPath,
          reason: "no ancestor package declares a `test` script",
        });
      }
    }
  }

  const allowlistErrors = [...allowlist.errors];
  for (const [key, entry] of allowlist.byKey) {
    if (entry.matched < entry.count) {
      allowlistErrors.push(
        `allowlist: unused capacity for ${key} (matched ${entry.matched}/${entry.count}) — decrement or remove`,
      );
    }
  }

  return {
    repoRoot,
    allowlistPath,
    scannedFiles,
    exclusives,
    orphanedSkips,
    suppressedSkips,
    trackedSkips,
    placeholderSkips,
    neverRunFiles,
    allowlistErrors,
    ok:
      exclusives.length === 0 &&
      orphanedSkips.length === 0 &&
      allowlistErrors.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export function formatReport(result, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const lines = [];
  const status = result.ok ? "PASS" : dryRun ? "DRY-RUN" : "FAIL";
  lines.push("");
  lines.push(`[lint-test-integrity] ${status} test-integrity gate`);
  lines.push(
    `[lint-test-integrity] scanned ${result.scannedFiles} test file(s) under ${SCAN_DIRS.join(", ")}`,
  );
  lines.push("");
  lines.push(
    `  exclusive (.only/fit)     : ${result.exclusives.length}  [blocking, target 0]`,
  );
  lines.push(
    `  orphaned disabled tests   : ${result.orphanedSkips.length}  [blocking — untracked, not allowlisted]`,
  );
  lines.push(`  suppressed (allowlisted)  : ${result.suppressedSkips.length}`);
  lines.push(`  tracked (links an issue)  : ${result.trackedSkips.length}`);
  lines.push(
    `  placeholder/runtime gates : ${result.placeholderSkips.length}  [informational]`,
  );
  lines.push(
    `  never-run test files      : ${result.neverRunFiles.length}  [informational]`,
  );

  if (result.exclusives.length > 0) {
    lines.push("");
    lines.push("[lint-test-integrity] Exclusive tests (remove `.only`/`fit`):");
    for (const hit of result.exclusives) {
      lines.push(`  - ${hit.file}:${hit.line}: ${hit.snippet}`);
    }
  }

  if (result.orphanedSkips.length > 0) {
    lines.push("");
    lines.push(
      "[lint-test-integrity] Orphaned disabled tests (link a #NNN tracking issue, delete, or allowlist with a reason):",
    );
    for (const skip of result.orphanedSkips) {
      lines.push(`  - ${skip.file}:${skip.line}: ${skip.snippet}`);
    }
  }

  if (result.allowlistErrors.length > 0) {
    lines.push("");
    lines.push("[lint-test-integrity] Allowlist errors:");
    for (const err of result.allowlistErrors) lines.push(`  - ${err}`);
  }

  if (dryRun && result.neverRunFiles.length > 0) {
    lines.push("");
    lines.push("[lint-test-integrity] Never-run test files (informational):");
    for (const f of result.neverRunFiles) {
      lines.push(`  - ${f.file}  (${f.reason})`);
    }
  }

  lines.push("");
  if (dryRun) {
    lines.push(
      "[lint-test-integrity] --dry-run set; findings did not affect the exit code.",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Build the ratchet allowlist JSON from the current orphaned + suppressed set. */
export function buildAllowlist(result) {
  const byKey = new Map();
  for (const skip of [...result.orphanedSkips, ...result.suppressedSkips]) {
    const key = `${skip.file}::${skip.title}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count++;
    } else {
      byKey.set(key, {
        file: skip.file,
        title: skip.title,
        count: 1,
        reason:
          skip.reason ??
          "grandfathered by #10718 test-integrity ratchet — disabled test, needs a tracking issue or deletion",
      });
    }
  }
  return {
    $comment:
      "Ratchet allowlist for lint-test-integrity.mjs (issue #10718). Each entry grandfathers a disabled real test. Reduce `count` / remove entries as skips are fixed or linked to a tracking issue; the gate fails on unused capacity so the debt only shrinks.",
    entries: [...byKey.values()].sort(
      (a, b) => a.file.localeCompare(b.file) || a.title.localeCompare(b.title),
    ),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHelp() {
  process.stdout.write(
    [
      "Usage: node packages/scripts/lint-test-integrity.mjs [options]",
      "",
      "Options:",
      "  --dry-run           Print the inventory but always exit 0.",
      "  --json              Print the raw JSON result.",
      "  --write-allowlist   (Re)generate the ratchet allowlist from the current tree.",
      "  --repo-root <path>  Scan a repo root other than the current checkout.",
      "  --allowlist <path>  Use a specific allowlist file.",
      "  --no-allowlist      Ignore the default allowlist.",
      "  --help              Show this help.",
      "",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    json: false,
    writeAllowlist: false,
    repoRoot: DEFAULT_REPO_ROOT,
    allowlistPath: DEFAULT_ALLOWLIST_PATH,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--dry-run" || arg === "--report-only")
      options.dryRun = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--write-allowlist") options.writeAllowlist = true;
    else if (arg === "--no-allowlist") options.allowlistPath = null;
    else if (arg === "--repo-root") options.repoRoot = argv[++i];
    else if (arg.startsWith("--repo-root=")) options.repoRoot = arg.slice(12);
    else if (arg === "--allowlist") options.allowlistPath = argv[++i];
    else if (arg.startsWith("--allowlist="))
      options.allowlistPath = arg.slice(12);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export function runCli(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`[lint-test-integrity] ${error.message}`);
    return 2;
  }
  if (options.help) {
    printHelp();
    return 0;
  }

  if (options.writeAllowlist) {
    const result = analyzeTestIntegrity({
      repoRoot: options.repoRoot,
      allowlistPath: null,
    });
    const allowlist = buildAllowlist(result);
    const target = path.resolve(
      options.allowlistPath ?? DEFAULT_ALLOWLIST_PATH,
    );
    fs.writeFileSync(target, `${JSON.stringify(allowlist, null, 2)}\n`);
    process.stdout.write(
      `[lint-test-integrity] wrote ${allowlist.entries.length} allowlist entry(ies) to ${target}\n`,
    );
    return 0;
  }

  const result = analyzeTestIntegrity(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(formatReport(result, options));
  }
  if (options.dryRun) return 0;
  return result.ok ? 0 : 1;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  process.exit(runCli());
}
