#!/usr/bin/env node
/**
 * Fails closed when a canonical Cloud release no longer owns its branch head.
 *
 * Admission can precede a protected-environment wait or a long serialized
 * release queue. This guard therefore resolves the authoritative remote ref at
 * each provider mutation boundary instead of trusting the earlier admission.
 * Explicit forced dispatches remain the only supported stale-SHA rollback path.
 */
import { execFileSync } from "../../scripts/lib/spawn-sync-captured.mjs";

const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const CANONICAL_REFS = new Set(["refs/heads/develop", "refs/heads/main"]);

function normalizeSha(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return COMMIT_SHA_PATTERN.test(normalized) ? normalized : null;
}

/**
 * Parses the exact one-line response expected from `git ls-remote`.
 * @param {string} output
 * @param {string} canonicalRef
 * @returns {string|null}
 */
export function parseCanonicalRemoteHead(output, canonicalRef) {
  if (typeof output !== "string" || !CANONICAL_REFS.has(canonicalRef)) {
    return null;
  }
  const records = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/));
  if (records.length !== 1) return null;
  const [sha, ref, ...extra] = records[0];
  if (extra.length > 0 || ref !== canonicalRef) return null;
  return normalizeSha(sha);
}

/**
 * Makes the strict source-ownership decision without performing I/O.
 * @param {object} input
 * @param {string|null|undefined} input.runSha
 * @param {string|null|undefined} input.canonicalRef
 * @param {string|null|undefined} input.canonicalHead
 * @param {boolean} [input.force]
 */
export function decideCanonicalDeploySource({
  runSha,
  canonicalRef,
  canonicalHead,
  force = false,
}) {
  const normalizedRun = normalizeSha(runSha);
  const normalizedHead = normalizeSha(canonicalHead);
  const normalizedRef =
    typeof canonicalRef === "string" ? canonicalRef.trim() : "";

  if (!normalizedRun) {
    return { allowed: false, reason: "invalid_run_sha" };
  }
  if (!CANONICAL_REFS.has(normalizedRef)) {
    return { allowed: false, reason: "invalid_canonical_ref" };
  }
  if (force) {
    return {
      allowed: true,
      reason: "forced",
      runSha: normalizedRun,
      canonicalRef: normalizedRef,
      canonicalHead: normalizedHead,
    };
  }
  if (!normalizedHead) {
    return {
      allowed: false,
      reason: "canonical_head_unresolved",
      runSha: normalizedRun,
      canonicalRef: normalizedRef,
    };
  }
  if (normalizedRun !== normalizedHead) {
    return {
      allowed: false,
      reason: "superseded_source",
      runSha: normalizedRun,
      canonicalRef: normalizedRef,
      canonicalHead: normalizedHead,
    };
  }
  return {
    allowed: true,
    reason: "current_source",
    runSha: normalizedRun,
    canonicalRef: normalizedRef,
    canonicalHead: normalizedHead,
  };
}

function parseArgs(argv) {
  const parsed = { runSha: null, canonicalRef: null, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--force") {
      parsed.force = true;
    } else if (argument === "--run-sha") {
      parsed.runSha = argv[index + 1] ?? null;
      index += 1;
    } else if (argument === "--canonical-ref") {
      parsed.canonicalRef = argv[index + 1] ?? null;
      index += 1;
    } else if (argument.startsWith("--run-sha=")) {
      parsed.runSha = argument.slice("--run-sha=".length);
    } else if (argument.startsWith("--canonical-ref=")) {
      parsed.canonicalRef = argument.slice("--canonical-ref=".length);
    } else {
      throw new Error(`Unsupported argument: ${argument}`);
    }
  }
  return parsed;
}

function resolveCanonicalHead(canonicalRef) {
  const output = execFileSync(
    "git",
    ["ls-remote", "--exit-code", "origin", canonicalRef],
    {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60000,
    },
  ).toString();
  const head = parseCanonicalRemoteHead(output, canonicalRef);
  if (!head) {
    throw new Error(`Remote returned no exact commit for ${canonicalRef}`);
  }
  return head;
}

function reportDecision(decision) {
  const prefix = decision.allowed
    ? "Canonical source accepted"
    : "::error::Canonical source rejected";
  console.log(`${prefix}: ${decision.reason}`);
  if (decision.runSha) console.log(`runSha=${decision.runSha}`);
  if (decision.canonicalRef)
    console.log(`canonicalRef=${decision.canonicalRef}`);
  if (decision.canonicalHead)
    console.log(`canonicalHead=${decision.canonicalHead}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const preliminary = decideCanonicalDeploySource({
    ...args,
    canonicalHead: null,
  });
  if (
    preliminary.reason === "invalid_run_sha" ||
    preliminary.reason === "invalid_canonical_ref"
  ) {
    reportDecision(preliminary);
    process.exitCode = 1;
    return;
  }
  if (args.force) {
    reportDecision(preliminary);
    return;
  }

  const canonicalHead = resolveCanonicalHead(args.canonicalRef);
  const decision = decideCanonicalDeploySource({ ...args, canonicalHead });
  reportDecision(decision);
  if (!decision.allowed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // error-policy:J1 the CLI boundary translates remote resolution failures
    // into a visible, fail-closed workflow result before provider mutation.
    console.error(
      `::error::Canonical source could not be verified: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}

export { parseArgs, resolveCanonicalHead };
