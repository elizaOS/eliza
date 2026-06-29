// Shared helpers for the per-platform evidence capture tooling (issue #9944).
//
// Every capture helper writes its three artifacts — a screenshot (.png), a
// screen recording (.mp4/.mov), and a log tail (.log) — into
//   .github/issue-evidence/<issue#>-<slug>/<platform>/
// and SKIPS WITH A REASON (clean exit 0 + a logged reason) when the platform
// or its tooling is unavailable, mirroring the `[skip]` pattern used by
// scripts/e2e-recordings/run-all.mjs. The convention is documented in
// .github/issue-evidence/README.md and PR_EVIDENCE.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "..", "..", "..");
export const ISSUE_EVIDENCE_DIR = path.join(
  REPO_ROOT,
  ".github",
  "issue-evidence",
);

export const DEFAULT_ISSUE = "9944";
export const DEFAULT_SLUG = "evidence-capture";
export const DEFAULT_SECONDS = 7;

/**
 * Parse the small, shared CLI flag set every capture helper understands:
 *   --issue=<n> --slug=<s> --platform=<p> --out=<dir> --seconds=<n> --serial=<id>
 * Bare `--seconds 7` (space-separated) is also accepted.
 */
export function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      flags[body] = argv[++i];
    } else {
      flags[body] = true;
    }
  }
  return flags;
}

/**
 * Resolve (and create) the per-platform evidence directory.
 * Honors an explicit `--out` override, otherwise builds the canonical
 * `.github/issue-evidence/<issue>-<slug>/<platform>/` path.
 */
export function evidenceDir({ issue, slug, platform, out }) {
  const dir = out
    ? path.resolve(out)
    : path.join(ISSUE_EVIDENCE_DIR, `${issue}-${slug}`, platform);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Structured `[ClassName] …` logger for a standalone capture script. */
export function makeLogger(className) {
  return (message) => console.log(`[${className}] ${message}`);
}

/**
 * Build a skip result. Helpers return this (instead of throwing) when the
 * platform/tooling is absent — the caller logs the reason and exits 0.
 */
export function skipped(className, reason) {
  return { className, skipped: true, reason, artifacts: {} };
}

/**
 * CLI epilogue shared by every helper's standalone entrypoint: print the
 * outcome and exit 0 on success/skip, non-zero only on a real failure.
 */
export function reportAndExit(result) {
  const log = makeLogger(result.className);
  if (result.skipped) {
    log(`[skip] ${result.reason}`);
    process.exit(0);
  }
  if (result.error) {
    log(`error: ${result.error}`);
    process.exit(1);
  }
  for (const [kind, file] of Object.entries(result.artifacts)) {
    if (!file) continue;
    const bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
    log(`${kind}: ${file} (${bytes} bytes)`);
  }
  process.exit(0);
}

/** True when this module file was invoked directly as `node <file>.mjs`. */
export function isMain(metaUrl) {
  return (
    process.argv[1] && fileURLToPath(metaUrl) === path.resolve(process.argv[1])
  );
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
