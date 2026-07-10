/**
 * Backend selection and subprocess-argument assembly for the e2e AI review
 * orchestrator (`run.mjs`). Pure decision logic only — no spawning, no I/O
 * beyond an injectable PATH probe — so every branch is unit-testable: which
 * reviewer CLIs are installed (codex / claude), how each is invoked in
 * read-only vs write mode, how a failed invocation's output is classified
 * (quota vs auth vs transient), and which backend to pick next once one has
 * exhausted its quota. Also owns the defensive "last JSON object" extractor
 * applied to reviewer stdout, since tolerating prose around the verdict is a
 * backend-output concern.
 */

import fs from "node:fs";
import path from "node:path";

/** Product decision: codex reviews run on gpt-5.6-sol unless --model overrides. */
export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";

/** Codex is preferred (stronger multimodal review); claude is the fallback. */
export const BACKEND_ORDER = ["codex", "claude"];

/** codex `-i` accepts a handful of images; more than 4 adds latency, not signal. */
export const MAX_CODEX_IMAGES = 4;

function defaultIsExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    // error-policy:J3 PATH probe: an inaccessible entry is an explicit
    // "not executable" answer, not a failure to surface.
    return false;
  }
}

/**
 * Probe PATH for the reviewer CLIs. Returns absolute paths (or null) per
 * backend. `pathEnv`/`isExecutable` are injectable for tests.
 */
export function detectBackends({
  pathEnv = process.env.PATH ?? "",
  isExecutable = defaultIsExecutable,
} = {}) {
  const dirs = pathEnv.split(path.delimiter).filter((dir) => dir.length > 0);
  const find = (name) => {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
    return null;
  };
  return { codex: find("codex"), claude: find("claude") };
}

/**
 * Argv for `codex exec`. Read-only sandbox by default; `write: true` is the
 * --fix path (workspace-write). Images beyond MAX_CODEX_IMAGES are dropped.
 */
export function buildCodexArgs({
  model = DEFAULT_CODEX_MODEL,
  repoRoot,
  prompt,
  images = [],
  write = false,
}) {
  if (typeof repoRoot !== "string" || repoRoot.length === 0) {
    throw new Error("buildCodexArgs: repoRoot is required");
  }
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new Error("buildCodexArgs: prompt is required");
  }
  // `-i/--image <FILE>...` is greedy (clap multi-value): it consumes every
  // following non-flag arg, so images must never sit directly before the
  // prompt positional. `-s`/`-C` after the images terminate the value list.
  return [
    "exec",
    "-m",
    model,
    "--skip-git-repo-check",
    ...images.slice(0, MAX_CODEX_IMAGES).flatMap((image) => ["-i", image]),
    "-s",
    write ? "workspace-write" : "read-only",
    "-C",
    repoRoot,
    prompt,
  ];
}

/**
 * Argv for `claude` non-interactive mode. `write: true` (the --fix path)
 * lets the session apply edits without prompting.
 */
export function buildClaudeArgs({ prompt, model, write = false }) {
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new Error("buildClaudeArgs: prompt is required");
  }
  return [
    "-p",
    ...(model ? ["--model", model] : []),
    ...(write ? ["--permission-mode", "acceptEdits"] : []),
    prompt,
  ];
}

// Quota is checked first because quota messages often also mention retrying
// (which would otherwise read as transient) — and quota is the one class that
// must exclude the backend for the rest of the run.
const QUOTA_PATTERNS = [
  /usage limit reached/i,
  /usage limit/i,
  /rate.?limit/i,
  /\b429\b/,
  /plan limit/i,
  /overloaded/i,
  /(?:insufficient|exceeded|out of) quota/i,
  /quota (?:exceeded|exhausted)/i,
];

const AUTH_PATTERNS = [
  /not (?:logged|signed) in/i,
  /\b401\b/,
  /unauthorized/i,
  /invalid api key/i,
  /authentication (?:failed|error|required)/i,
  /please (?:log ?in|sign ?in|run .{0,40}login)/i,
];

const TRANSIENT_PATTERNS = [
  /\b(?:500|502|503|504)\b/,
  /timed? ?out/i,
  /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE/,
  /temporarily unavailable/i,
  /connection (?:error|reset|closed|refused)/i,
  /network error/i,
];

/**
 * Classify a failed backend invocation from its combined stderr+stdout.
 * `quota` excludes the backend for the rest of the run; `auth` and `other`
 * are terminal for the invocation; `transient` is retryable in principle.
 */
export function classifyBackendError(text) {
  const haystack = String(text ?? "");
  if (QUOTA_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return { kind: "quota" };
  }
  if (AUTH_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return { kind: "auth" };
  }
  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return { kind: "transient" };
  }
  return { kind: "other" };
}

/**
 * Choose the backend for the next invocation. `preference` is `auto`
 * (codex first, claude fallback) or a specific backend name; `excluded`
 * holds backends that hit quota earlier in the run. Returns
 * `{ name, command, model }` or null when nothing usable remains.
 */
export function pickBackend({
  preference = "auto",
  detected,
  excluded = new Set(),
  model,
}) {
  const candidates = preference === "auto" ? BACKEND_ORDER : [preference];
  for (const name of candidates) {
    if (excluded.has(name)) continue;
    const command = detected?.[name];
    if (!command) continue;
    return {
      name,
      command,
      model:
        name === "codex" ? (model ?? DEFAULT_CODEX_MODEL) : (model ?? null),
    };
  }
  return null;
}

/**
 * Extract the LAST parseable top-level JSON object from free-form CLI output
 * (reviewers wrap the verdict in prose, markdown fences, progress lines).
 * String-aware balanced scan; a successful parse jumps past the whole object
 * so nested objects inside it are never returned on their own. Returns the
 * parsed object or null.
 */
export function extractLastJsonObject(text) {
  const source = String(text ?? "");
  let last = null;
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf("{", i);
    if (open === -1) break;
    const close = scanBalancedObject(source, open);
    if (close === -1) {
      i = open + 1;
      continue;
    }
    try {
      const parsed = JSON.parse(source.slice(open, close + 1));
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        last = parsed;
        i = close + 1;
        continue;
      }
    } catch {
      // error-policy:J3 candidate span is untrusted model prose; a failed
      // parse means "not the JSON object", and the scan resumes one char on.
    }
    i = open + 1;
  }
  return last;
}

function scanBalancedObject(source, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
