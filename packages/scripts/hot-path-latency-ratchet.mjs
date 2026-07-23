#!/usr/bin/env node
/**
 * Diff-scoped guard against NEW blocking awaits on the turn-serving hot path.
 *
 * Turn latency is dominated by synchronous awaited work that runs before the
 * reply streams: model calls, network fetches, and DB reads awaited inside
 * provider `get()` bodies or on the core message-serving path. The repo already
 * carries some of these; a repo-wide count gate would go stale the moment
 * develop merges an unrelated change. So — exactly like
 * error-policy-ratchet.mjs — enforcement is scoped to the diff:
 *
 *   base = git merge-base <base-ref> HEAD        (default base-ref origin/develop)
 *   for each production source file the branch touches (base..HEAD):
 *     fail iff its CURRENT (working-tree) unsanctioned hot-await count is
 *     GREATER than the same file's count at `base`.
 *
 * When no base ref is resolvable (shallow clone without origin/develop) the
 * guard cannot scope a diff and passes rather than block on an unknowable
 * baseline. On `develop` itself the diff is empty and the guard is a no-op.
 *
 * Two scopes are tracked:
 *   - `providerHotAwait` — an awaited hot-path call (`await runtime.useModel(`,
 *     `await fetch(`, `await runtime.getMemories/getRelationships/...`) inside
 *     a Provider `get: async (...)` body. Providers run during composeState on
 *     every turn; a blocking await there taxes every reply.
 *   - `manifestHotAwait` — the same call shapes inside a small committed
 *     allowlist of turn-serving files (HOT_PATH_MANIFEST below). For
 *     packages/core/src/runtime.ts only the `async composeState(...)` body is
 *     in scope; the other manifest files are whole-file.
 *
 * Sanctioned shapes are NOT flagged:
 *   - fire-and-forget: `void fetch(...)`, `fetch(...).catch(...)` — no `await`,
 *     so they never match by construction;
 *   - the await sits lexically inside `ctx.waitUntil(...)`, `Promise.race(...)`,
 *     or a `withTimeout(...)` wrapper (background / bounded work);
 *   - the enclosing region shows a cache-hit guard (`getCache(` / `cache.get(`
 *     / `cache.has(` earlier in the same body) — the await is a cold-start cost;
 *   - the file declares a provider `timeoutMs:` budget (runtime bounds it);
 *   - an inline `// latency-ok: <reason>` annotation on the same or previous
 *     line — the grep-able escape hatch, analogous to error-policy's
 *     `// error-policy:J<N>`.
 *
 * Detection is lexical over comment/string-stripped source (annotations are
 * read from the raw text) so the script has zero dependencies and identical
 * behavior at the merge-base and in the working tree — the ratchet only needs
 * consistency, not perfection: a shape miscounted the same way on both sides
 * never regresses.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = new Set(process.argv.slice(2));

/**
 * Repo root, resolved lazily (per call) so the bun:test harness can retarget
 * the git plumbing at a throwaway repo via HOT_PATH_LATENCY_ROOT after import.
 */
function repoRoot() {
  return process.env.HOT_PATH_LATENCY_ROOT
    ? path.resolve(process.env.HOT_PATH_LATENCY_ROOT)
    : path.resolve(import.meta.dirname, "../..");
}

const KIND_LABELS = {
  providerHotAwait: "awaited hot-path call inside a Provider get() body",
  manifestHotAwait: "awaited hot-path call in a manifest turn-serving file",
};

/**
 * Turn-serving files where any new awaited fetch/DB/useModel on the
 * synchronous path is flagged. Value "composeState" scopes the scan to the
 * `async composeState(...)` method body; "whole" scans the entire file.
 */
export const HOT_PATH_MANIFEST = {
  "packages/core/src/runtime.ts": "composeState",
  "packages/core/src/services/message.ts": "whole",
  "packages/cloud/shared/src/lib/services/eliza-sandbox.ts": "whole",
};

// Awaited calls that block the serving path: model inference, network I/O,
// and the common runtime DB-read surface. `getCache` is deliberately absent —
// cache reads are the sanctioned fast path.
const DB_READ_METHODS = [
  "useModel",
  "getMemoriesByRoomIds",
  "getMemoriesByIds",
  "getMemories",
  "searchMemories",
  "getRelationships",
  "getEntitiesForRoom",
  "getKnowledge",
];

const HOT_AWAIT_RE = new RegExp(
  String.raw`\bawait\s+(?:(?:(?:this\s*\.\s*)?runtime|this)\s*\.\s*(?:${DB_READ_METHODS.join("|")})|fetch)\s*\(`,
  "g",
);

// Callee names whose enclosing call sanctions an await found inside it.
const SANCTIONED_CALLEES = new Set(["waitUntil", "race", "withTimeout"]);

const CACHE_GUARD_RE =
  /\b(?:getCache|cacheGet)\s*\(|\bcache\s*\.\s*(?:get|has)\s*\(/;

const ANNOTATION_RE = /\/\/\s*latency-ok:/;

const EXCLUDED_SEGMENTS = new Set([
  "__fixtures__",
  "__mocks__",
  "__tests__",
  "fixtures",
  "generated",
  "mock",
  "mocks",
  "test",
  "tests",
]);

const JSON_FLAG = args.has("--json");
const SELF_TEST = args.has("--self-test");
const REPORT = args.has("--report");

function usage() {
  console.log(`Usage: node packages/scripts/hot-path-latency-ratchet.mjs [options]

Diff-scoped: fails only when a production source file the branch touches
increases its own unsanctioned hot-path blocking-await count vs the merge-base
with origin/develop. Immune to unrelated develop drift.

Options:
  --json        Print machine-readable diff-scoped result JSON.
  --report      Also compute + print the repo-wide totals (informational only).
  --self-test   Run the classifier + comparison self-test fixtures.

Env:
  HOT_PATH_LATENCY_BASE_REF  Override the base ref (default: origin/develop, then develop).
  HOT_PATH_LATENCY_ROOT      Override the repo root (used by the test harness).
`);
}

if (args.has("--help") || args.has("-h")) {
  usage();
  process.exit(0);
}

function isProductionSourceFile(relPath) {
  if (!/\.(ts|tsx)$/.test(relPath)) return false;
  if (/\.d\.ts$/.test(relPath)) return false;
  if (!relPath.startsWith("src/") && !relPath.includes("/src/")) return false;

  const parts = relPath.split("/");
  if (parts.some((part) => EXCLUDED_SEGMENTS.has(part))) return false;

  const base = path.basename(relPath);
  if (/\.(test|spec|e2e|stories?|fixture|mock)\.(ts|tsx)$/.test(base)) {
    return false;
  }
  return true;
}

// Length-preserving blanking of comments and string/template contents so match
// indexes and line numbers stay aligned with the raw source. Same routine as
// error-policy-ratchet's lexical fallback.
function stripCommentsAndStrings(sourceText) {
  let out = "";
  let state = "code";
  let quote = "";
  for (let i = 0; i < sourceText.length; i += 1) {
    const ch = sourceText[i];
    const next = sourceText[i + 1];

    if (state === "lineComment") {
      if (ch === "\n") {
        state = "code";
        out += ch;
      } else {
        out += " ";
      }
      continue;
    }

    if (state === "blockComment") {
      if (ch === "*" && next === "/") {
        out += "  ";
        i += 1;
        state = "code";
      } else {
        out += ch === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (state === "string") {
      if (ch === "\\") {
        out += " ";
        if (next) {
          out += next === "\n" ? "\n" : " ";
          i += 1;
        }
      } else if (ch === quote) {
        out += " ";
        state = "code";
      } else {
        out += ch === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      out += "  ";
      i += 1;
      state = "lineComment";
      continue;
    }
    if (ch === "/" && next === "*") {
      out += "  ";
      i += 1;
      state = "blockComment";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      out += " ";
      quote = ch;
      state = "string";
      continue;
    }
    out += ch;
  }
  return out;
}

function lineForIndex(sourceText, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (sourceText[i] === "\n") line += 1;
  }
  return line;
}

/** Index of the delimiter matching src[openIdx], or -1. Strings are pre-stripped. */
function matchDelim(src, openIdx, open, close) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i += 1) {
    if (src[i] === open) depth += 1;
    else if (src[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * [start, end) index ranges of every `get: async (...)` body — the Provider
 * shape. Handles arrow bodies, expression-bodied arrows, and `async function`.
 */
function extractGetRegions(src) {
  const regions = [];
  for (const m of src.matchAll(/\bget\s*:\s*async\b/g)) {
    let i = m.index + m[0].length;
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (src.startsWith("function", i)) {
      i += "function".length;
      while (i < src.length && /\s/.test(src[i])) i += 1;
      while (i < src.length && /[\w$]/.test(src[i])) i += 1;
      while (i < src.length && /\s/.test(src[i])) i += 1;
    }
    if (src[i] !== "(") continue;
    const paramsEnd = matchDelim(src, i, "(", ")");
    if (paramsEnd < 0) continue;
    i = paramsEnd + 1;
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (src[i] === "=" && src[i + 1] === ">") {
      i += 2;
      while (i < src.length && /\s/.test(src[i])) i += 1;
    }
    if (src[i] === "{") {
      const bodyEnd = matchDelim(src, i, "{", "}");
      if (bodyEnd > 0) regions.push([i + 1, bodyEnd]);
      continue;
    }
    // Expression-bodied arrow: scan to the first top-level `,` or closer.
    let depth = 0;
    let j = i;
    for (; j < src.length; j += 1) {
      const ch = src[j];
      if (ch === "(" || ch === "[" || ch === "{") depth += 1;
      else if (ch === ")" || ch === "]" || ch === "}") {
        if (depth === 0) break;
        depth -= 1;
      } else if (ch === "," && depth === 0) break;
    }
    regions.push([i, j]);
  }
  return regions;
}

/** Body range of `async composeState(...)`, or null when absent. */
function composeStateRegion(src) {
  const m = /\basync\s+composeState\s*\(/.exec(src);
  if (!m) return null;
  const paramsOpen = src.indexOf("(", m.index);
  const paramsEnd = matchDelim(src, paramsOpen, "(", ")");
  if (paramsEnd < 0) return null;
  let i = paramsEnd + 1;
  while (i < src.length && src[i] !== "{") {
    // Skip a return-type annotation between params and body.
    if (src[i] === ";") return null;
    i += 1;
  }
  if (src[i] !== "{") return null;
  const bodyEnd = matchDelim(src, i, "{", "}");
  if (bodyEnd < 0) return null;
  return [i + 1, bodyEnd];
}

/**
 * Walk backward from `idx` looking for an unmatched enclosing `(` whose callee
 * is a sanctioned wrapper (waitUntil / Promise.race / withTimeout). Balanced
 * delimiter pairs between here and the enclosure cancel out, so an earlier
 * *sibling* `waitUntil(...)` call never sanctions a later bare await.
 */
function insideSanctionedCall(src, idx) {
  let depth = 0;
  for (let i = idx - 1; i >= 0; i -= 1) {
    const ch = src[i];
    if (ch === ")" || ch === "]" || ch === "}") {
      depth += 1;
    } else if (ch === "(" || ch === "[" || ch === "{") {
      if (depth > 0) {
        depth -= 1;
        continue;
      }
      if (ch !== "(") continue; // enclosing block/array — keep walking outward
      let j = i - 1;
      while (j >= 0 && /\s/.test(src[j])) j -= 1;
      const end = j;
      while (j >= 0 && /[\w$.]/.test(src[j])) j -= 1;
      const callee = src.slice(j + 1, end + 1);
      const last = callee.split(".").pop();
      if (SANCTIONED_CALLEES.has(last)) return true;
    }
  }
  return false;
}

/** Line numbers (1-based) carrying a `// latency-ok:` annotation, from raw text. */
function annotatedLines(rawText) {
  const lines = new Set();
  rawText.split("\n").forEach((line, i) => {
    if (ANNOTATION_RE.test(line)) lines.add(i + 1);
  });
  return lines;
}

function scanRegion(stripped, region, kind, relPath, annotations, findings) {
  const [start, end] = region;
  const regionText = stripped.slice(start, end);
  HOT_AWAIT_RE.lastIndex = 0;
  for (const m of regionText.matchAll(HOT_AWAIT_RE)) {
    const absIdx = start + m.index;
    const line = lineForIndex(stripped, absIdx);
    if (annotations.has(line) || annotations.has(line - 1)) continue;
    if (insideSanctionedCall(stripped, absIdx)) continue;
    if (CACHE_GUARD_RE.test(regionText.slice(0, m.index))) continue;
    findings.push({ kind, file: relPath, line });
  }
}

/**
 * Classify one source file's text into hot-await findings. Exported for the
 * self-test and the bun:test harness.
 */
export function collectFindings(sourceText, relPath) {
  const stripped = stripCommentsAndStrings(sourceText);
  const annotations = annotatedLines(sourceText);
  const findings = [];

  // (A) Provider scope: every `get: async (...)` body, unless the file
  // declares a provider timeoutMs budget (the runtime bounds it).
  if (!/\btimeoutMs\s*:/.test(stripped)) {
    for (const region of extractGetRegions(stripped)) {
      scanRegion(
        stripped,
        region,
        "providerHotAwait",
        relPath,
        annotations,
        findings,
      );
    }
  }

  // (B) Manifest scope: committed allowlist of turn-serving files.
  const manifestMode = HOT_PATH_MANIFEST[relPath];
  if (manifestMode) {
    // A renamed/missing composeState falls back to whole-file: over-counting
    // is consistent on both sides of the ratchet, silently disarming is not.
    const region =
      manifestMode === "composeState"
        ? (composeStateRegion(stripped) ?? [0, stripped.length])
        : [0, stripped.length];
    scanRegion(
      stripped,
      region,
      "manifestHotAwait",
      relPath,
      annotations,
      findings,
    );
  }

  return findings;
}

function summarize(findings) {
  const counts = Object.fromEntries(
    Object.keys(KIND_LABELS).map((kind) => [kind, 0]),
  );
  for (const finding of findings) counts[finding.kind] += 1;
  return counts;
}

export function countText(sourceText, relPath) {
  return summarize(collectFindings(sourceText, relPath));
}

function git(argv, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", argv, {
      cwd: repoRoot(),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", allowFailure ? "ignore" : "inherit"],
    });
  } catch (err) {
    if (allowFailure) return null;
    throw err;
  }
}

/** First resolvable ref among the env override, origin/develop, develop. */
export function resolveBaseRef() {
  const candidates = [
    process.env.HOT_PATH_LATENCY_BASE_REF,
    "origin/develop",
    "develop",
  ].filter(Boolean);
  for (const ref of candidates) {
    if (
      git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
        allowFailure: true,
      })
    ) {
      return ref;
    }
  }
  return null;
}

/** Merge-base of the base ref and HEAD; null if it cannot be computed. */
export function mergeBaseWith(ref) {
  const out = git(["merge-base", ref, "HEAD"], { allowFailure: true });
  return out ? out.trim() : null;
}

/** Production source files the branch touches relative to the merge-base. */
export function changedProductionFiles(base) {
  const out = git(["diff", "--name-only", "-z", `${base}`, "HEAD"], {
    allowFailure: true,
  });
  if (!out) return [];
  return [...new Set(out.split("\0").filter(Boolean))]
    .filter(isProductionSourceFile)
    .sort();
}

/** File content at `base`, or null if the file did not exist there. */
function baseContent(base, relPath) {
  return git(["show", `${base}:${relPath}`], { allowFailure: true });
}

/** Working-tree content, or null if the file was deleted on the branch. */
function workingTreeContent(relPath) {
  try {
    return readFileSync(path.join(repoRoot(), relPath), "utf8");
  } catch {
    return null;
  }
}

const ZERO_COUNTS = Object.fromEntries(
  Object.keys(KIND_LABELS).map((kind) => [kind, 0]),
);

/**
 * Pure per-file comparison: which kinds increased vs the base counts.
 * Exported for the self-test.
 */
export function compareFileCounts(current, baseCounts) {
  const regressions = [];
  for (const kind of Object.keys(KIND_LABELS)) {
    const cur = current[kind] ?? 0;
    const prev = baseCounts[kind] ?? 0;
    if (cur > prev) regressions.push({ kind, current: cur, base: prev });
  }
  return regressions;
}

/**
 * For each changed production file, compare its working-tree count to its
 * count at the merge-base. New files compare against zero.
 */
export function diffScopedRegressions(base, files) {
  const perFile = [];
  const regressions = [];
  for (const relPath of files) {
    const currentText = workingTreeContent(relPath);
    if (currentText === null) continue; // deleted on the branch — nothing added.
    const current = countText(currentText, relPath);

    const baseText = baseContent(base, relPath);
    const baseCounts =
      baseText === null ? { ...ZERO_COUNTS } : countText(baseText, relPath);

    perFile.push({ file: relPath, current, base: baseCounts });
    for (const r of compareFileCounts(current, baseCounts)) {
      regressions.push({ file: relPath, ...r });
    }
  }
  return { perFile, regressions };
}

/** Repo-wide informational totals (never gates). */
export function repoWideTotals() {
  const output = git(["ls-files"]);
  const files = [...new Set(output.split("\n").filter(Boolean))].filter(
    isProductionSourceFile,
  );
  const findings = [];
  for (const relPath of files) {
    findings.push(
      ...collectFindings(
        readFileSync(path.join(repoRoot(), relPath), "utf8"),
        relPath,
      ),
    );
  }
  return { filesScanned: files.length, counts: summarize(findings) };
}

function printHumanSummary({ baseRef, base, files, perFile, regressions }) {
  console.log(
    `[hot-path-latency-ratchet] base ${baseRef} (${base.slice(0, 10)}); ${files.length} changed production source file(s)`,
  );
  for (const row of perFile) {
    const deltas = Object.keys(KIND_LABELS)
      .map(
        (kind) => `${kind} ${row.base[kind] ?? 0}->${row.current[kind] ?? 0}`,
      )
      .join(", ");
    console.log(`[hot-path-latency-ratchet]   ${row.file}: ${deltas}`);
  }
  if (regressions.length === 0) {
    console.log(
      "[hot-path-latency-ratchet] no new hot-path blocking awaits in touched files",
    );
    return;
  }
  console.error(
    "[hot-path-latency-ratchet] new hot-path blocking awaits added in touched files:",
  );
  for (const r of regressions) {
    console.error(
      `  - ${r.file}: ${KIND_LABELS[r.kind]} ${r.base} -> ${r.current}`,
    );
  }
  console.error(
    "\nA PR may not ADD awaited useModel/fetch/DB-read calls to provider get() bodies or manifest turn-serving files. Move the work off the serving path (ctx.waitUntil, fire-and-forget), bound it (Promise.race + timeout, provider timeoutMs), serve from cache, or annotate the line with `// latency-ok: <reason>` and justify it in the PR.",
  );
}

/** Throws (rather than exiting) so the fixtures also run under bun:test. */
function assertSelfTest(condition, label, detail) {
  if (condition) return;
  throw new Error(
    `self-test failed: ${label}${detail ? ` — ${JSON.stringify(detail)}` : ""}`,
  );
}

export function runSelfTest() {
  const providerPath = "packages/foo/src/providers/facts.ts";

  const bareFetchProvider = `
    export const factsProvider: Provider = {
      name: "FACTS",
      get: async (runtime, message, state) => {
        const res = await fetch("https://example.com/facts");
        const rows = await runtime.getMemories({ tableName: "facts" });
        return { text: String(res) + rows.length };
      },
    };
  `;
  const bare = countText(bareFetchProvider, providerPath);
  assertSelfTest(
    bare.providerHotAwait === 2 && bare.manifestHotAwait === 0,
    "bare await fetch + DB read in provider get() not flagged",
    bare,
  );

  const waitUntilProvider = `
    export const factsProvider: Provider = {
      name: "FACTS",
      get: async (runtime, message, state, ctx) => {
        ctx.waitUntil((async () => {
          const res = await fetch("https://example.com/facts");
          await runtime.getMemories({ tableName: "facts" });
        })());
        return { text: "" };
      },
    };
  `;
  const waited = countText(waitUntilProvider, providerPath);
  assertSelfTest(
    waited.providerHotAwait === 0,
    "waitUntil-wrapped awaits were flagged",
    waited,
  );

  // A balanced earlier waitUntil() sibling must NOT sanction a later bare await.
  const siblingProvider = `
    export const factsProvider: Provider = {
      get: async (runtime, message, state, ctx) => {
        ctx.waitUntil(warmCache(runtime));
        const res = await fetch("https://example.com/facts");
        return { text: String(res) };
      },
    };
  `;
  const sibling = countText(siblingProvider, providerPath);
  assertSelfTest(
    sibling.providerHotAwait === 1,
    "bare await after a sibling waitUntil call escaped the flag",
    sibling,
  );

  const annotatedProvider = `
    export const factsProvider: Provider = {
      get: async (runtime, message, state) => {
        // latency-ok: cold-start only; result is cached for the session
        const res = await fetch("https://example.com/facts");
        return { text: String(res) };
      },
    };
  `;
  const annotated = countText(annotatedProvider, providerPath);
  assertSelfTest(
    annotated.providerHotAwait === 0,
    "latency-ok annotation not honored",
    annotated,
  );

  const fireAndForgetProvider = `
    export const factsProvider: Provider = {
      get: async (runtime, message, state) => {
        void fetch("https://example.com/facts").catch(() => undefined);
        return { text: "" };
      },
    };
  `;
  const forget = countText(fireAndForgetProvider, providerPath);
  assertSelfTest(
    forget.providerHotAwait === 0,
    "non-awaited fire-and-forget fetch was flagged",
    forget,
  );

  const racedProvider = `
    export const factsProvider: Provider = {
      get: async (runtime, message, state) => {
        const res = await Promise.race([fetch("https://example.com"), timeout(800)]);
        return { text: String(res) };
      },
    };
  `;
  const raced = countText(racedProvider, providerPath);
  assertSelfTest(
    raced.providerHotAwait === 0,
    "Promise.race-bounded fetch was flagged",
    raced,
  );

  const budgetedProvider = `
    export const factsProvider: Provider = {
      name: "FACTS",
      timeoutMs: 500,
      get: async (runtime, message, state) => {
        const res = await fetch("https://example.com/facts");
        return { text: String(res) };
      },
    };
  `;
  const budgeted = countText(budgetedProvider, providerPath);
  assertSelfTest(
    budgeted.providerHotAwait === 0,
    "timeoutMs-budgeted provider was flagged",
    budgeted,
  );

  const cacheGuardedProvider = `
    export const factsProvider: Provider = {
      get: async (runtime, message, state) => {
        const cached = await runtime.getCache("facts");
        if (cached) return { text: cached };
        const res = await fetch("https://example.com/facts");
        return { text: String(res) };
      },
    };
  `;
  const guarded = countText(cacheGuardedProvider, providerPath);
  assertSelfTest(
    guarded.providerHotAwait === 0,
    "cache-hit-guarded fetch was flagged",
    guarded,
  );

  // Non-provider file: same await outside any get() body is out of scope A.
  const helperFile = `
    export async function loadFacts(runtime) {
      const res = await fetch("https://example.com/facts");
      return res;
    }
  `;
  const helper = countText(helperFile, "packages/foo/src/lib/helpers.ts");
  assertSelfTest(
    helper.providerHotAwait === 0 && helper.manifestHotAwait === 0,
    "await outside a provider get() in a non-manifest file was flagged",
    helper,
  );

  // Manifest scope: whole-file manifest entry flags the awaited useModel...
  const manifestSource = `
    export class MessageService {
      async handle(runtime, message) {
        const reply = await this.runtime.useModel(ModelType.TEXT_LARGE, {});
        return reply;
      }
    }
  `;
  const manifest = countText(
    manifestSource,
    "packages/core/src/services/message.ts",
  );
  assertSelfTest(
    manifest.manifestHotAwait === 1 && manifest.providerHotAwait === 0,
    "manifest-file awaited useModel not flagged",
    manifest,
  );
  // ...and the identical content at a non-manifest path stays clean.
  const nonManifest = countText(
    manifestSource,
    "packages/foo/src/services/message.ts",
  );
  assertSelfTest(
    nonManifest.manifestHotAwait === 0,
    "manifest scope leaked to a non-manifest path",
    nonManifest,
  );

  // runtime.ts: only the composeState body is in scope.
  const runtimeSource = `
    export class AgentRuntime {
      async other() {
        const res = await fetch("https://example.com");
        return res;
      }
      async composeState(message, includeList) {
        const rows = await this.getMemories({ roomId: message.roomId });
        return rows;
      }
    }
  `;
  const runtimeCounts = countText(
    runtimeSource,
    "packages/core/src/runtime.ts",
  );
  assertSelfTest(
    runtimeCounts.manifestHotAwait === 1,
    "composeState region scoping wrong for runtime.ts",
    runtimeCounts,
  );

  // Diff-scoped comparison: only an INCREASE over the same file's base regresses.
  assertSelfTest(
    compareFileCounts(
      { providerHotAwait: 2, manifestHotAwait: 0 },
      { providerHotAwait: 2, manifestHotAwait: 0 },
    ).length === 0,
    "unchanged file regressed",
  );
  const added = compareFileCounts(
    { providerHotAwait: 3, manifestHotAwait: 0 },
    { providerHotAwait: 2, manifestHotAwait: 0 },
  );
  assertSelfTest(
    added.length === 1 && added[0].kind === "providerHotAwait",
    "added hot await not caught by comparison",
  );
  assertSelfTest(
    compareFileCounts(
      { providerHotAwait: 1, manifestHotAwait: 0 },
      { providerHotAwait: 2, manifestHotAwait: 0 },
    ).length === 0,
    "removal counted as regression",
  );
  const newFileSlop = compareFileCounts(
    { providerHotAwait: 1, manifestHotAwait: 0 },
    { ...ZERO_COUNTS },
  );
  assertSelfTest(
    newFileSlop.length === 1 && newFileSlop[0].kind === "providerHotAwait",
    "new-file hot await not caught",
  );

  console.log("[hot-path-latency-ratchet] self-test passed");
}

function main() {
  if (SELF_TEST) {
    try {
      runSelfTest();
    } catch (err) {
      console.error(
        `[hot-path-latency-ratchet] ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
    process.exit(0);
  }

  const baseRef = resolveBaseRef();
  const base = baseRef ? mergeBaseWith(baseRef) : null;

  if (!base) {
    const reason = baseRef
      ? `no merge-base with ${baseRef}`
      : "no base ref (origin/develop) resolvable";
    const repoWide = REPORT ? repoWideTotals() : null;
    if (JSON_FLAG) {
      console.log(
        JSON.stringify(
          { ok: true, skipped: reason, baseRef, mergeBase: null, repoWide },
          null,
          2,
        ),
      );
    } else {
      console.log(
        `[hot-path-latency-ratchet] ${reason}; diff-scoped check skipped (pass)`,
      );
      if (repoWide) {
        console.log(
          `[hot-path-latency-ratchet] repo-wide (informational): providerHotAwait ${repoWide.counts.providerHotAwait}, manifestHotAwait ${repoWide.counts.manifestHotAwait} across ${repoWide.filesScanned} files`,
        );
      }
    }
    process.exit(0);
  }

  const files = changedProductionFiles(base);
  const { perFile, regressions } = diffScopedRegressions(base, files);
  const repoWide = REPORT ? repoWideTotals() : null;

  if (JSON_FLAG) {
    console.log(
      JSON.stringify(
        {
          ok: regressions.length === 0,
          baseRef,
          mergeBase: base,
          changedFiles: files,
          perFile,
          regressions,
          repoWide,
        },
        null,
        2,
      ),
    );
  } else {
    printHumanSummary({ baseRef, base, files, perFile, regressions });
    if (repoWide) {
      console.log(
        `[hot-path-latency-ratchet] repo-wide (informational): providerHotAwait ${repoWide.counts.providerHotAwait}, manifestHotAwait ${repoWide.counts.manifestHotAwait} across ${repoWide.filesScanned} files`,
      );
    }
  }

  if (regressions.length > 0) process.exit(1);
}

// Guarded so the bun:test harness can import the pure classifiers without
// triggering the git-plumbing main path.
const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
