#!/usr/bin/env node
/**
 * audit-no-suggestion-chips.mjs — regression gate for the views doctrine
 * "the agent suggests in chat, the view stays quiet" (epic #13560, child
 * #13588). Once the in-view suggestion-chip surface is deleted, nothing may
 * reintroduce it. This gate fails CI when a banned surface reappears in tracked
 * source:
 *
 *   1. DELETED SYMBOLS — the `ChatEmptyStateWithRecommendations` component and
 *      the `useChatPrefill` chip hook were removed. Any reference (import, JSX,
 *      re-export, mock) is a resurrection and must not merge. The
 *      `dispatchChatPrefill` EVENT is intentionally NOT banned — the agent-side
 *      proactive pipeline still uses it; only the in-view chip UI is gone.
 *
 *   2. BANNED CHIP COPY — the specific recommendation/"create-your-first" prompt
 *      strings the de-chipping removed. A designed-empty view names what is empty
 *      in neutral copy; it never re-adds a tappable "ask the agent to X" chip.
 *
 * Scope: tracked `.ts`/`.tsx` under `packages/` and `plugins/` (this script and
 * the epic/issue docs are excluded so the gate can name what it bans).
 *
 * Usage:
 *   node packages/scripts/audit-no-suggestion-chips.mjs             # CI gate
 *   node packages/scripts/audit-no-suggestion-chips.mjs --self-test # prove it works
 *
 * Exit codes: 0 clean, 1 violations found, 2 usage/internal error.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const SELF = "packages/scripts/audit-no-suggestion-chips.mjs";

const BANNED_SYMBOLS = ["ChatEmptyStateWithRecommendations", "useChatPrefill"];

const BANNED_STRINGS = [
  "What should I add to Knowledge?",
  "Ask Eliza to fix a bug",
  "Introduce someone in chat",
  "Teach Eliza in chat",
  "Define your voice",
  "Dispatch a coding agent to fix a failing test",
  // Empty-state copy that instructs the user to ask/tell the agent is a
  // suggestion in disguise (epic #13560 quiet-view contract). A designed-empty
  // view names what is empty; it never tells the user to "Ask Eliza to …".
  "Ask Eliza to map who you know",
  "Describe a task in the chat below",
  "then describe a task in the chat below",
];

const PATHSPECS = [
  "packages/**/*.ts",
  "packages/**/*.tsx",
  "plugins/**/*.ts",
  "plugins/**/*.tsx",
  `:!${SELF}`,
];

/** Fixed-string git-grep across the tracked source globs. Returns match lines. */
function grep(needle) {
  try {
    const out = execFileSync(
      "git",
      ["grep", "-n", "-F", needle, "--", ...PATHSPECS],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    return out.split("\n").filter(Boolean);
  } catch (err) {
    // git grep exits 1 with no output when there are no matches — that is the
    // clean case, not a failure. Any other exit is a real error.
    if (err.status === 1 && !err.stdout) return [];
    throw err;
  }
}

function runGate() {
  const violations = [];
  for (const symbol of BANNED_SYMBOLS) {
    for (const line of grep(symbol)) {
      violations.push({ needle: symbol, kind: "symbol", line });
    }
  }
  for (const str of BANNED_STRINGS) {
    for (const line of grep(str)) {
      violations.push({ needle: str, kind: "string", line });
    }
  }
  return violations;
}

function report(violations) {
  if (violations.length === 0) {
    console.log(
      "[audit-no-suggestion-chips] clean — no deleted chip symbols or banned chip copy reappeared.",
    );
    return 0;
  }
  console.error(
    `[audit-no-suggestion-chips] ${violations.length} banned suggestion-chip surface(s) reappeared:`,
  );
  for (const v of violations) {
    console.error(`  (${v.kind}) "${v.needle}" — ${v.line}`);
  }
  console.error(
    "\nDesigned-empty views name what is empty in neutral copy; the agent suggests next steps in chat (#13588).",
  );
  return 1;
}

/**
 * Fixed-string git-grep against a single on-disk file via `--no-index`, so the
 * self-test can prove detection against a planted fixture without mutating the
 * repo index/tree. Returns match lines.
 */
function grepFile(needle, dir, file) {
  try {
    // Run inside `dir` (outside the repo) so `git grep --no-index` does not
    // reject the path as being outside the worktree.
    const out = execFileSync(
      "git",
      ["grep", "--no-index", "-n", "-F", needle, "--", file],
      { cwd: dir, encoding: "utf8" },
    );
    return out.split("\n").filter(Boolean);
  } catch (err) {
    if (err.status === 1 && !err.stdout) return [];
    throw err;
  }
}

/**
 * Prove the gate actually detects a violation. Two assertions:
 *   1. LIVE TREE CLEAN — the deleted chip surface stays deleted (real CI gate).
 *   2. POSITIVE DETECTION — plant a fixture containing a banned symbol AND a
 *      banned copy string, grep it, and assert BOTH are flagged. A matcher that
 *      silently matched nothing (the prior bug) fails here.
 */
function selfTest() {
  // The gate must be GREEN on the current tree (the chip surface is deleted).
  const live = runGate();
  if (live.length !== 0) {
    console.error(
      "[audit-no-suggestion-chips] self-test FAILED: gate is not clean on the current tree.",
    );
    report(live);
    return 1;
  }

  // Plant a real fixture with one banned symbol + one banned copy string and
  // assert the matcher flags each. This exercises the positive-detection path
  // that the live (clean) tree cannot.
  const bannedSymbol = BANNED_SYMBOLS[0];
  const bannedString = BANNED_STRINGS[0];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chip-audit-selftest-"));
  const fixtureName = "planted-violation.tsx";
  const fixture = path.join(dir, fixtureName);
  try {
    fs.writeFileSync(
      fixture,
      [
        "// planted self-test fixture — MUST be flagged by the gate",
        `import { ${bannedSymbol} } from "./nowhere";`,
        `const copy = "${bannedString}";`,
        `export { ${bannedSymbol}, copy };`,
        "",
      ].join("\n"),
    );

    const symbolHits = grepFile(bannedSymbol, dir, fixtureName);
    const stringHits = grepFile(bannedString, dir, fixtureName);
    if (symbolHits.length === 0 || stringHits.length === 0) {
      console.error(
        "[audit-no-suggestion-chips] self-test FAILED: planted violation was NOT detected " +
          `(symbol hits=${symbolHits.length}, string hits=${stringHits.length}). The gate is not actually matching.`,
      );
      return 1;
    }

    // And a nonsense needle in the same fixture must NOT match (no false positives).
    const nonsense = grepFile("__no_such_chip_needle_zzz__", dir, fixtureName);
    if (nonsense.length !== 0) {
      console.error(
        "[audit-no-suggestion-chips] self-test FAILED: matcher produced a false positive.",
      );
      return 1;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(
    "[audit-no-suggestion-chips] self-test PASSED — gate is clean on the current tree AND flags a planted symbol+copy violation.",
  );
  return 0;
}

const isSelfTest = process.argv.includes("--self-test");
try {
  process.exit(isSelfTest ? selfTest() : report(runGate()));
} catch (err) {
  console.error(`[audit-no-suggestion-chips] internal error: ${err.message}`);
  process.exit(2);
}
