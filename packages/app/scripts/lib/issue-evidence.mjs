// Shared helpers for the per-platform evidence-capture scripts (issue #9944).
//
// One place owns: resolving the repo root, the `.github/issue-evidence/`
// artifact directory, the `<issue#>-<slug>-<platform>.<ext>` naming convention
// (per PR_EVIDENCE.md and .github/issue-evidence/README.md), CLI flag parsing,
// the skip-with-reason exit, and a best-effort backend-log pull. The iOS and
// Android capture helpers both build on this so the path math and conventions
// live here, not duplicated per platform.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// lib -> scripts -> app -> packages -> repo root
export const REPO_ROOT = path.resolve(here, "..", "..", "..", "..");
export const ISSUE_EVIDENCE_DIR = path.join(
  REPO_ROOT,
  ".github",
  "issue-evidence",
);

/**
 * Truthiness for an env var that carries a boolean intent. Treats the common
 * falsey spellings (`"0"`, `"false"`, `"no"`, `"off"`, empty/whitespace) as
 * false and any other non-empty value as true, so `CI=true`, `CI=1`, and a bare
 * `CI=""` (GitHub sets `CI=true`, but a defensively-empty value should NOT arm
 * a hard gate) all resolve sanely.
 */
function envFlagIsTrue(value) {
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "") return false;
  return !(
    normalized === "0" ||
    normalized === "false" ||
    normalized === "no" ||
    normalized === "off"
  );
}

/**
 * Resolve whether a capture run must PRODUCE evidence (vs. being allowed to
 * soft-skip when the platform/tooling is absent). This is the fix for the
 * "green-with-nothing" disease: when evidence was explicitly requested, a
 * `skip()` (no device / not the right OS / tool missing) must become a hard,
 * non-zero failure instead of exiting 0 with zero artifacts.
 *
 * Sources, in precedence order:
 *   1. An explicit opt-OUT always wins: `--no-require-evidence`, or
 *      `--require-evidence false|0|no|off`. This lets an operator run a capture
 *      locally under CI without the gate arming.
 *   2. An explicit opt-IN: a bare `--require-evidence` (or `=true|1|yes|on`).
 *   3. Env opt-in: `E2E_REQUIRE_EVIDENCE` / `ELIZA_REQUIRE_EVIDENCE` truthy.
 *   4. Auto-on under CI: `CI` truthy (GitHub Actions et al.).
 * Otherwise false (local ad-hoc runs stay soft-skippable — behavior-preserving).
 *
 * Pure + exported so it is unit-testable without spawning a process.
 */
export function resolveRequireEvidence(
  argv = process.argv.slice(2),
  env = process.env,
) {
  // Scan argv for the flag (last occurrence wins) so an explicit value or an
  // explicit --no- form is authoritative over the env/CI defaults.
  let explicit; // undefined | true | false
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--no-require-evidence") {
      explicit = false;
      continue;
    }
    if (token === "--require-evidence") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        const v = next.trim().toLowerCase();
        explicit = !(v === "0" || v === "false" || v === "no" || v === "off");
        i++;
      } else {
        explicit = true;
      }
      continue;
    }
    if (token.startsWith("--require-evidence=")) {
      const v = token.slice("--require-evidence=".length).trim().toLowerCase();
      explicit = !(v === "0" || v === "false" || v === "no" || v === "off");
    }
  }
  if (explicit !== undefined) return explicit;

  if (
    envFlagIsTrue(env?.E2E_REQUIRE_EVIDENCE) ||
    envFlagIsTrue(env?.ELIZA_REQUIRE_EVIDENCE)
  ) {
    return true;
  }
  return envFlagIsTrue(env?.CI);
}

/** Parse `--flag value` and boolean `--flag` from argv into a flat object. */
export function parseFlags(argv = process.argv.slice(2)) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/**
 * Build an artifact base name. With `--issue`/`--slug`: `<issue>-<slug>-<platform>`
 * (the PR_EVIDENCE.md convention); otherwise a timestamped fallback so ad-hoc
 * runs never collide.
 */
export function evidenceBaseName({ issue, slug, platform }) {
  if (issue) {
    const safeSlug = String(slug ?? "capture")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return `${issue}-${safeSlug}-${platform}`;
  }
  return `${platform}-capture-${timestamp()}`;
}

/** Ensure the issue-evidence dir exists and return an absolute path inside it. */
export function evidencePath(baseName, ext) {
  fs.mkdirSync(ISSUE_EVIDENCE_DIR, { recursive: true });
  return path.join(ISSUE_EVIDENCE_DIR, `${baseName}.${ext}`);
}

/**
 * When run under the e2e-recordings sweep (`E2E_RECORD=1`), also mirror an
 * artifact into `e2e-recordings/<suite>/test-results/` so the recordings dir
 * isn't empty for the registered suite. Returns the mirrored path or null.
 */
export function mirrorToRecordings(suite, srcPath) {
  if (!process.env.E2E_RECORD || !fs.existsSync(srcPath)) return null;
  const dir = path.join(
    REPO_ROOT,
    "e2e-recordings",
    suite,
    "test-results",
    "capture",
  );
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(srcPath));
  fs.copyFileSync(srcPath, dest);
  return dest;
}

// Built-in default API port for the dev backend console-log endpoint. Mirrors
// `DEFAULT_DESKTOP_API_PORT` in packages/shared/src/runtime-env.ts — kept inline
// so this leaf capture lib stays dependency-light (node builtins only). If the
// canonical default changes, update it there and here.
export const DEFAULT_BACKEND_LOG_PORT = 31337;

// Env keys, in precedence order, the dev/capture orchestrator uses to advertise
// the (possibly auto-shifted) backend API port. Mirrors `DESKTOP_API_PORT_KEYS`
// in packages/shared/src/runtime-env.ts (ELIZA_API_PORT wins over ELIZA_PORT).
const BACKEND_LOG_PORT_ENV_KEYS = ["ELIZA_API_PORT", "ELIZA_PORT"];

/**
 * Resolve the dev backend API port the capture run should probe, honoring the
 * orchestrator's auto-shifted port (agent worktrees run parallel stacks and the
 * orchestrator advertises the shifted port via ELIZA_API_PORT / ELIZA_PORT).
 * A bare hardcoded default silently probes 31337, gets nothing on a shifted
 * stack, and the capture still finishes green with NO backend-log artifact
 * (#13624). First non-empty valid positive integer wins; else the built-in
 * default. Never throws — an unparseable/out-of-range env value is ignored.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {number}
 */
export function resolveBackendLogPort(env = process.env) {
  for (const key of BACKEND_LOG_PORT_ENV_KEYS) {
    const raw = env?.[key];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    // Only a bare positive integer is a valid port; reject "3000abc", "-1",
    // "0", "99999999", "1.5", etc. rather than silently coercing.
    if (!/^\d+$/.test(trimmed)) continue;
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
      return parsed;
    }
  }
  return DEFAULT_BACKEND_LOG_PORT;
}

/**
 * Best-effort pull of the dev backend console log (the structured `[ClassName]`
 * stream) so a capture run ships logs alongside the screenshot + recording.
 * Never throws — returns the written path or null when the endpoint is absent.
 *
 * The port defaults to the orchestrator-resolved backend port (ELIZA_API_PORT /
 * ELIZA_PORT / built-in) so a capture run on a port-shifted parallel stack pulls
 * the log from the RIGHT backend instead of silently probing 31337 and shipping
 * no log (#13624). An explicit `{ port }` still wins for callers that know it.
 */
export function captureBackendLog(
  baseName,
  { port = resolveBackendLogPort(), maxLines = 400 } = {},
) {
  const url = `http://127.0.0.1:${port}/api/dev/console-log?maxLines=${maxLines}`;
  const res = spawnSync("curl", ["-fsS", "--max-time", "5", url], {
    encoding: "utf8",
  });
  if (res.status !== 0 || !res.stdout) return null;
  const out = evidencePath(baseName, "log");
  fs.writeFileSync(out, res.stdout, "utf8");
  return out;
}

/**
 * Print a skip-with-reason line and exit.
 *
 * Default (evidence NOT required): exit 0 — capture is non-fatal when the
 * platform/tooling is absent, matching scripts/e2e-recordings/run-all.mjs.
 *
 * When evidence WAS explicitly required (`--require-evidence`, or auto-on under
 * CI — see resolveRequireEvidence): print a distinct failure line and exit
 * NON-ZERO (1). A capture that was demanded but produced nothing is a real
 * failure, not a silent green-skip. This is the core of the #13624 fix: the
 * skip contract can no longer swallow a missing artifact when the caller asked
 * for one.
 *
 * @param {string} platform
 * @param {string} reason
 * @param {{ requireEvidence?: boolean }} [opts] override the resolved default
 *   (primarily for tests / callers that already parsed the flag).
 */
export function skip(platform, reason, opts = {}) {
  const required =
    opts.requireEvidence !== undefined
      ? opts.requireEvidence
      : resolveRequireEvidence();
  if (required) {
    console.error(
      `[capture:${platform}] [require-evidence] evidence was required but not captured: ${reason}`,
    );
    process.exit(1);
  }
  console.log(`[capture:${platform}] [skip] ${reason}`);
  process.exit(0);
}

export function logFor(platform) {
  return (message) => console.log(`[capture:${platform}] ${message}`);
}
