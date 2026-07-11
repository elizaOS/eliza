/**
 * Diff-review gate for coding sub-agent PRs.
 *
 * Before the orchestrator turns a coding sub-agent's work into a pull request,
 * the produced changeset gets a structured, deterministic review pass. This is
 * a quality-hardening seam, NOT an LLM code review: it applies cheap sanity
 * constraints that a machine can decide with certainty, so an obviously-broken
 * or dangerous PR is blocked (or at least annotated) BEFORE it reaches GitHub.
 *
 * Checks (each maps to one {@link DiffGateFinding}):
 *  - `empty-diff`     — HARD: nothing to review, a PR with no changes is a bug.
 *  - `secret`         — HARD: an added line matches a credential/secret pattern
 *                       (reuses `@elizaos/core`'s `getDefaultRedactPatterns()`,
 *                       the single source of truth for value-shape secrets so
 *                       this gate and the log/redaction layer never drift).
 *  - `forbidden-file` — HARD: a changed path is a lockfile, a binary/build
 *                       artifact, or a build-config file (vite.config / next.config
 *                       / webpack.config …) the agent should never be editing in
 *                       a feature PR (these are the exact files our own review
 *                       rules forbid touching).
 *  - `oversize`       — WARN: the diff exceeds a line budget; large diffs are a
 *                       review-quality signal, not a hard error.
 *
 * Fail-safe posture (deliberate): the DEFAULT verdict is **warn-and-annotate**.
 * We only BLOCK on hard violations — secrets and forbidden files (and the
 * degenerate empty diff). Everything else surfaces as an annotation so a human
 * still sees the signal without the gate becoming a flaky merge-blocker. When
 * NOTHING is configured, the gate still runs with these built-in defaults; it is
 * always-on because the hard checks (secrets/binaries) are safety, not taste.
 *
 * @module services/diff-review-gate
 */

import { createHash } from "node:crypto";
import { ElizaError, getDefaultRedactPatterns } from "@elizaos/core";

/** Severity of a single gate finding. */
export type DiffGateSeverity = "block" | "warn";

/** Which check produced a finding. */
export type DiffGateCheck =
  | "empty-diff"
  | "secret"
  | "forbidden-file"
  | "oversize"
  | "truncated-diff"
  | "truncated-files";

/** One issue the gate found in the reviewed changeset. */
export interface DiffGateFinding {
  check: DiffGateCheck;
  severity: DiffGateSeverity;
  /** Human-readable one-liner suitable for the task events stream / PR body. */
  message: string;
  /** Offending path, when the finding is file-scoped. */
  file?: string;
}

/** Structured outcome of a gate run. */
export interface DiffGateResult {
  /** `true` iff there are ZERO `block`-severity findings (PR may proceed). */
  passed: boolean;
  /** All findings (block + warn), in check order. */
  findings: DiffGateFinding[];
  /** Convenience split: the blocking subset. */
  blocking: DiffGateFinding[];
  /** Convenience split: the warn (annotate-only) subset. */
  warnings: DiffGateFinding[];
  /** Lines of diff scanned (added + removed hunk lines). */
  scannedLines: number;
}

/** The changeset handed to the gate. */
export interface DiffGateInput {
  /** Unified `git diff` text for the branch vs its PR base. */
  diff: string;
  /** Changed file paths (repo-relative), used for the forbidden-file check. */
  changedFiles: string[];
  /**
   * True when `diff` was truncated at the capture budget. The gate then can NOT
   * prove the absence of a secret in the unseen tail, so it fails CLOSED: a
   * `truncated-diff` BLOCK. A partial safety scan that silently passes would let
   * a credential added past the budget slip through, which defeats the gate's
   * whole purpose.
   */
  diffTruncated?: boolean;
  /** True when the changed-file list exceeded the capture budget. */
  changedFilesTruncated?: boolean;
}

/** Tunables. All optional; sensible defaults baked in. */
export interface DiffGateConfig {
  /** Diff exceeding this many changed (+/-) lines emits an `oversize` WARN. */
  oversizeLineThreshold?: number;
  /**
   * Extra forbidden path patterns (glob-ish substrings/regex sources) layered
   * ON TOP of the built-ins, for operators who want to forbid more. Never
   * shrinks the built-in safety set.
   */
  extraForbiddenPatterns?: string[];
  /**
   * Disable the oversize WARN entirely (some repos legitimately land large
   * generated-then-committed diffs). Hard checks are never disable-able.
   */
  disableOversizeWarn?: boolean;
}

const DEFAULT_OVERSIZE_LINE_THRESHOLD = 4000;

/**
 * Lockfiles — regenerated from a manifest, never hand-edited, and a frequent
 * source of merge conflicts + supply-chain surface. An agent touching one in a
 * feature PR is almost always a mistake.
 */
const LOCKFILE_BASENAMES = new Set<string>([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "npm-shrinkwrap.json",
  "composer.lock",
  "poetry.lock",
  "cargo.lock",
  "gemfile.lock",
  "go.sum",
]);

/**
 * Build/bundler config files. Editing these silently changes the build for the
 * whole repo; our own PR rules explicitly forbid a coding agent touching them.
 * Matched by basename (case-insensitive) with any of these stems + a config
 * extension, so `vite.config.ts`, `vite.config.mjs`, `next.config.js` all hit.
 */
const BUILD_CONFIG_STEMS = [
  "vite.config",
  "vitest.config",
  "next.config",
  "webpack.config",
  "rollup.config",
  "esbuild.config",
  "tsup.config",
  "astro.config",
  "svelte.config",
  "nuxt.config",
  "index.html",
];

/**
 * Binary / build-artifact extensions an agent should never be committing into a
 * source PR. Kept intentionally tight: images, archives, compiled objects,
 * media, fonts. A legitimate asset drop is rare enough to warrant a human PR.
 */
const BINARY_EXTENSIONS = new Set<string>([
  // images
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "ico",
  "webp",
  "tiff",
  "psd",
  // media
  "mp3",
  "mp4",
  "mov",
  "avi",
  "webm",
  "wav",
  "flac",
  // archives / packages
  "zip",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "jar",
  "war",
  // compiled / objects
  "exe",
  "dll",
  "so",
  "dylib",
  "o",
  "a",
  "class",
  "wasm",
  "node",
  "bin",
  // fonts
  "ttf",
  "otf",
  "woff",
  "woff2",
  "eot",
  // misc heavy
  "pdf",
  "sqlite",
  "db",
]);

/** Compiled secret patterns, sourced once from core's redact patterns. */
const SECRET_PATTERNS: readonly RegExp[] = compileSecretPatterns();

function compileSecretPatterns(): RegExp[] {
  const compiled: RegExp[] = [];
  for (const raw of getDefaultRedactPatterns()) {
    // Match core's redaction parser: a `/pattern/flags` literal keeps its flags
    // (forcing `g`), otherwise the raw source compiles with `gi`. We add `m` so
    // matching works line-by-line. Compiling with only `gm` (dropping the `i`)
    // would miss lowercase credential shapes core's source-of-truth catches
    // (e.g. `database_password=…`, `authorization: Bearer …`), so we preserve
    // case-insensitivity exactly as core does. A pattern that fails to compile
    // is skipped rather than aborting the whole gate.
    const compiledPattern = compileRedactPattern(raw);
    if (compiledPattern) compiled.push(compiledPattern);
  }
  return compiled;
}

/**
 * Compile one core redact pattern string the SAME way core's `parsePattern`
 * does, so the gate never matches less broadly than the redaction layer:
 *  - a `/source/flags` literal keeps its flags (adding `g` if absent);
 *  - a bare source compiles case-insensitively (`gi`).
 * We additionally add the `m` flag in both cases because the gate scans the
 * whole diff text and anchors should be line-scoped.
 */
function compileRedactPattern(raw: string): RegExp | null {
  if (!raw.trim()) return null;
  const literal = raw.match(/^\/(.+)\/([gimsuy]*)$/);
  try {
    if (literal) {
      let flags = literal[2];
      if (!flags.includes("g")) flags += "g";
      if (!flags.includes("m")) flags += "m";
      return new RegExp(literal[1], flags);
    }
    return new RegExp(raw, "gim");
  } catch {
    return null;
  }
}

function basename(path: string): string {
  const normalized = path.split("\\").join("/");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

function extensionOf(path: string): string {
  const base = basename(path).toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1);
}

/** Whether a changed path is one the gate hard-forbids. Returns a reason or null. */
function forbiddenReason(
  path: string,
  extraMatchers: readonly RegExp[],
): string | null {
  const base = basename(path).toLowerCase();

  if (LOCKFILE_BASENAMES.has(base)) {
    return "lockfile (regenerated from manifest, never hand-edited)";
  }

  for (const stem of BUILD_CONFIG_STEMS) {
    // Match `<stem>` exactly or `<stem>.<ext>` (config file with an extension).
    if (base === stem || base.startsWith(`${stem}.`)) {
      return `build/bundler config file (${stem})`;
    }
  }

  const ext = extensionOf(path);
  if (ext && BINARY_EXTENSIONS.has(ext)) {
    return `binary/build artifact (.${ext})`;
  }

  for (const matcher of extraMatchers) {
    matcher.lastIndex = 0;
    if (matcher.test(path)) {
      return "matched an operator-configured forbidden pattern";
    }
  }

  return null;
}

/**
 * Lines an agent ADDED in the diff. We only scan added content for secrets: a
 * secret that was ALREADY in the base tree (and only appears as context or a
 * removal) is not something this PR is introducing, and flagging it would make
 * the gate block on pre-existing debt it can't fix.
 */
function addedLines(diff: string): string[] {
  const out: string[] = [];
  for (const line of diff.split("\n")) {
    // `+++ b/file` header lines start with `+++`; skip those, keep real adds.
    if (line.startsWith("+") && !line.startsWith("+++")) {
      out.push(line.slice(1));
    }
  }
  return out;
}

/** Count of changed (added or removed) hunk lines, excluding file headers. */
function countChangedLines(diff: string): number {
  let count = 0;
  for (const line of diff.split("\n")) {
    if (
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---"))
    ) {
      count += 1;
    }
  }
  return count;
}

/**
 * Run the diff-review gate over a coding sub-agent's changeset.
 *
 * Pure and deterministic: no I/O, no clock, no LLM. Given the same diff +
 * file list it always returns the same verdict, so it is trivially unit-tested
 * and safe to run in the PR-creation hot path.
 */
export function reviewDiff(
  input: DiffGateInput,
  config: DiffGateConfig = {},
): DiffGateResult {
  const findings: DiffGateFinding[] = [];
  const diff = input.diff ?? "";
  const changedFiles = input.changedFiles ?? [];
  const scannedLines = countChangedLines(diff);

  // 1) Empty-diff — HARD. A PR from a coding task with no changes is a bug in
  //    the pipeline (the agent produced nothing, or the diff capture failed);
  //    creating an empty PR just wastes a reviewer's attention.
  const hasFileEntries = changedFiles.length > 0;
  if (diff.trim().length === 0 && !hasFileEntries) {
    findings.push({
      check: "empty-diff",
      severity: "block",
      message:
        "Empty diff: the coding task produced no changes to review. Refusing to open an empty PR.",
    });
    // Nothing else to scan.
    return finalize(findings, scannedLines);
  }

  // 1b) Truncated diff — HARD (fail closed). If the diff was cut at the capture
  //     budget, the secret scan below can only see a PREFIX of the changeset, so
  //     it can't prove a credential wasn't introduced in the unseen tail. Block
  //     rather than pass a partial safety scan. The forbidden-file check still
  //     runs on the (complete) changed-file list, and we still scan the visible
  //     prefix for secrets so an early secret is reported too.
  if (input.diffTruncated) {
    findings.push({
      check: "truncated-diff",
      severity: "block",
      message:
        "Diff too large to fully scan for secrets: the changeset exceeded the review budget and was truncated. Split the PR so the gate can scan the whole diff.",
    });
  }
  if (input.changedFilesTruncated) {
    findings.push({
      check: "truncated-files",
      severity: "block",
      message:
        "Changed-file list is incomplete: the changeset exceeded the file-count review budget. Split the PR so every path can be checked.",
    });
  }

  // 2) Forbidden files — HARD.
  const extraMatchers = compileExtraForbidden(config.extraForbiddenPatterns);
  for (const file of changedFiles) {
    const reason = forbiddenReason(file, extraMatchers);
    if (reason) {
      findings.push({
        check: "forbidden-file",
        severity: "block",
        message: `Forbidden file in changeset: ${reason}.`,
        file,
      });
    }
  }

  // 3) Secrets in ADDED lines — HARD.
  const seenSecretLines = new Set<string>();
  for (const line of addedLines(diff)) {
    if (matchesSecret(line)) {
      // Never echo the secret itself into the finding; report a redacted
      // fingerprint (leading chars) so the reviewer can locate it without the
      // gate re-leaking the credential into the events stream / PR body.
      const fingerprint = redactedFingerprint(line);
      if (seenSecretLines.has(fingerprint)) continue;
      seenSecretLines.add(fingerprint);
      findings.push({
        check: "secret",
        severity: "block",
        message: `Possible secret/credential in an added line (${fingerprint}). Remove it before opening a PR.`,
      });
    }
  }

  // 4) Oversize — WARN (annotate only).
  if (!config.disableOversizeWarn) {
    const threshold =
      config.oversizeLineThreshold ?? DEFAULT_OVERSIZE_LINE_THRESHOLD;
    if (scannedLines > threshold) {
      findings.push({
        check: "oversize",
        severity: "warn",
        message: `Large diff: ${scannedLines} changed lines exceed the ${threshold}-line review threshold. Consider splitting the PR.`,
      });
    }
  }

  return finalize(findings, scannedLines);
}

function finalize(
  findings: DiffGateFinding[],
  scannedLines: number,
): DiffGateResult {
  const blocking = findings.filter((f) => f.severity === "block");
  const warnings = findings.filter((f) => f.severity === "warn");
  return {
    passed: blocking.length === 0,
    findings,
    blocking,
    warnings,
    scannedLines,
  };
}

function compileExtraForbidden(patterns?: string[]): RegExp[] {
  if (!patterns || patterns.length === 0) return [];
  const out: RegExp[] = [];
  for (const raw of patterns) {
    if (!raw?.trim()) continue;
    try {
      out.push(new RegExp(raw));
    } catch (cause) {
      throw new ElizaError("Invalid coding diff-gate forbidden-path pattern", {
        code: "INVALID_CODING_DIFF_GATE_PATTERN",
        context: { pattern: raw },
        cause,
      });
    }
  }
  return out;
}

function matchesSecret(line: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(line)) return true;
  }
  return false;
}

/**
 * A safe, non-reversible fingerprint of a line that tripped the secret scan.
 * No source characters are included because a credential may begin at column
 * zero; even a short prefix would re-leak part of the value into events/logs.
 */
function redactedFingerprint(line: string): string {
  const trimmed = line.trim();
  const digest = createHash("sha256")
    .update(trimmed)
    .digest("hex")
    .slice(0, 12);
  return `sha256:${digest} (${trimmed.length} chars)`;
}

/**
 * Render a gate result as a compact, human-readable summary for the task
 * events stream and PR-block messages. Empty string when there is nothing to
 * report (passed with no warnings).
 */
export function summarizeDiffGate(result: DiffGateResult): string {
  if (result.findings.length === 0) return "";
  const lines: string[] = [];
  if (result.blocking.length > 0) {
    lines.push(
      `Diff-review gate BLOCKED (${result.blocking.length} hard violation${
        result.blocking.length === 1 ? "" : "s"
      }):`,
    );
    for (const f of result.blocking) {
      lines.push(
        `  ✗ [${f.check}] ${f.message}${f.file ? ` — ${f.file}` : ""}`,
      );
    }
  }
  if (result.warnings.length > 0) {
    lines.push(
      `Diff-review gate warnings (${result.warnings.length}, annotate-only):`,
    );
    for (const f of result.warnings) {
      lines.push(
        `  ! [${f.check}] ${f.message}${f.file ? ` — ${f.file}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}
