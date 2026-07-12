#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/../.." && pwd)"

# shellcheck source=artifact-paths.sh
# shellcheck disable=SC1091
. "$SCRIPT_DIR/artifact-paths.sh"

RUNNER_COMPOSE_FILE="${RUNNER_COMPOSE_FILE:-$DEPLOY_DIR/compose.actions-runner.yml}"
RUNNER_CONFIG_FILE="${RUNNER_CONFIG_FILE:-$DEPLOY_DIR/runner/data/config.yml}"
RUNNER_EVIDENCE_OUTPUT="${RUNNER_EVIDENCE_OUTPUT:-$(eliza_artifact_path eliza-hub-runner-evidence.json)}"
RUNNER_ISOLATION_AUDIT_OUTPUT="${RUNNER_ISOLATION_AUDIT_OUTPUT:-$(eliza_artifact_path eliza-hub-runner-isolation-audit.json)}"
RUNNER_PRODUCTION_EVIDENCE_OUTPUT="${RUNNER_PRODUCTION_EVIDENCE_OUTPUT:-$(eliza_artifact_path eliza-hub-runner-production-evidence.json)}"
RUNNER_SMOKE_EVIDENCE_FILE="${RUNNER_SMOKE_EVIDENCE_FILE:-${RUNNER_SMOKE_EVIDENCE_OUTPUT:-$(eliza_artifact_path eliza-hub-runner-smoke-evidence.json)}}"
RUNNER_EVIDENCE_SKIP_LIVE_CHECK="${RUNNER_EVIDENCE_SKIP_LIVE_CHECK:-false}"
RUNNER_EVIDENCE_SKIP_SMOKE_CHECK="${RUNNER_EVIDENCE_SKIP_SMOKE_CHECK:-false}"

log() {
  printf '[runner-evidence] %s\n' "$*"
}

fail() {
  printf '[runner-evidence] error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<EOF
Usage: $0

Writes private runner isolation evidence and an audit result.

Default outputs:
  RUNNER_EVIDENCE_OUTPUT=$ELIZA_ARTIFACT_ROOT/eliza-hub-runner-evidence.json
  RUNNER_ISOLATION_AUDIT_OUTPUT=$ELIZA_ARTIFACT_ROOT/eliza-hub-runner-isolation-audit.json
  RUNNER_PRODUCTION_EVIDENCE_OUTPUT=$ELIZA_ARTIFACT_ROOT/eliza-hub-runner-production-evidence.json

Required attestations for production-ready evidence:
  RUNNER_EGRESS_REVIEWED=true
  RUNNER_SECRET_EXPOSURE_REVIEWED=true

Trusted smoke evidence:
  By default this verifies RUNNER_SMOKE_WORKFLOW through the Forgejo API and
  infers RUNNER_TRUSTED_SMOKE_WORKFLOW_PASSED from the live run.

Optional metadata:
  RUNNER_SMOKE_EVIDENCE_FILE
  RUNNER_PRODUCTION_EVIDENCE_OUTPUT
  RUNNER_REVIEWED_BY
  RUNNER_REVIEWED_AT

By default this runs scripts/check-actions-runner.sh first. Set
RUNNER_EVIDENCE_SKIP_LIVE_CHECK=true only to generate a draft evidence file
from static config. Set RUNNER_EVIDENCE_SKIP_SMOKE_CHECK=true only when feeding
pre-verified smoke evidence manually.
EOF
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

require_file() {
  [[ -f "$1" ]] || fail "missing required file: $1"
}

is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

main() {
  if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    usage
    return 0
  fi

  require_command node
  eliza_prepare_artifact_dirs
  require_file "$RUNNER_COMPOSE_FILE"
  require_file "$RUNNER_CONFIG_FILE"

  if ! is_true "$RUNNER_EVIDENCE_SKIP_LIVE_CHECK"; then
    log "running live runner isolation checks"
    "$SCRIPT_DIR/check-actions-runner.sh"
    RUNNER_REGISTRATION_TESTED="${RUNNER_REGISTRATION_TESTED:-true}"
  else
    RUNNER_REGISTRATION_TESTED="${RUNNER_REGISTRATION_TESTED:-false}"
  fi
  export RUNNER_REGISTRATION_TESTED

  if ! is_true "$RUNNER_EVIDENCE_SKIP_SMOKE_CHECK"; then
    log "verifying trusted runner smoke workflow"
    RUNNER_SMOKE_EVIDENCE_OUTPUT="$RUNNER_SMOKE_EVIDENCE_FILE" \
      "$SCRIPT_DIR/runner-smoke-evidence.mjs"
  fi

  umask 077
  mkdir -p \
    "$(dirname "$RUNNER_EVIDENCE_OUTPUT")" \
    "$(dirname "$RUNNER_ISOLATION_AUDIT_OUTPUT")" \
    "$(dirname "$RUNNER_PRODUCTION_EVIDENCE_OUTPUT")"

  RUNNER_COMPOSE_FILE="$RUNNER_COMPOSE_FILE" \
    RUNNER_CONFIG_FILE="$RUNNER_CONFIG_FILE" \
    RUNNER_EVIDENCE_OUTPUT="$RUNNER_EVIDENCE_OUTPUT" \
    RUNNER_SMOKE_EVIDENCE_FILE="$RUNNER_SMOKE_EVIDENCE_FILE" \
    node --input-type=module <<'NODE'
import { existsSync, readFileSync, writeFileSync } from "node:fs";

function parseBoolean(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return /^(?:1|true|yes|on)$/i.test(String(value));
}

function readJson(path) {
  if (!path || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

const smokeEvidence = readJson(process.env.RUNNER_SMOKE_EVIDENCE_FILE);
const runnerSmoke = smokeEvidence?.runnerSmoke ?? smokeEvidence?.smoke ?? null;
const smokePassed = parseBoolean(process.env.RUNNER_TRUSTED_SMOKE_WORKFLOW_PASSED)
  || parseBoolean(runnerSmoke?.trustedWorkflowPassed)
  || parseBoolean(runnerSmoke?.passed)
  || parseBoolean(runnerSmoke?.ok);

const evidence = {
  composeConfig: readFileSync(process.env.RUNNER_COMPOSE_FILE, "utf8"),
  runnerConfig: readFileSync(process.env.RUNNER_CONFIG_FILE, "utf8"),
  registration: {
    tested: parseBoolean(process.env.RUNNER_REGISTRATION_TESTED),
  },
  smoke: {
    trustedWorkflowPassed: smokePassed,
    workflowRunUrl: process.env.RUNNER_SMOKE_WORKFLOW_RUN_URL || runnerSmoke?.workflowRunUrl || null,
    workflowRun: runnerSmoke
      ? {
          passed: smokePassed,
          repository: runnerSmoke.repository ?? null,
          workflow: runnerSmoke.workflow ?? null,
          ref: runnerSmoke.ref ?? null,
          runId: runnerSmoke.runId ?? null,
          runNumber: runnerSmoke.runNumber ?? null,
          status: runnerSmoke.status ?? null,
          conclusion: runnerSmoke.conclusion ?? null,
          url: runnerSmoke.workflowRunUrl ?? null,
        }
      : null,
  },
  reviews: {
    egressReviewed: parseBoolean(process.env.RUNNER_EGRESS_REVIEWED),
    secretExposureReviewed: parseBoolean(process.env.RUNNER_SECRET_EXPOSURE_REVIEWED),
    reviewedBy: process.env.RUNNER_REVIEWED_BY || null,
    reviewedAt: process.env.RUNNER_REVIEWED_AT || new Date().toISOString(),
  },
};

writeFileSync(process.env.RUNNER_EVIDENCE_OUTPUT, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
NODE

  log "wrote runner evidence to $RUNNER_EVIDENCE_OUTPUT"

  if node "$REPO_ROOT/services/merge-steward/src/cli.js" runner-isolation \
    < "$RUNNER_EVIDENCE_OUTPUT" \
    > "$RUNNER_ISOLATION_AUDIT_OUTPUT"; then
    log "runner isolation audit passed and wrote $RUNNER_ISOLATION_AUDIT_OUTPUT"
  else
    log "runner isolation audit blocked; see $RUNNER_ISOLATION_AUDIT_OUTPUT"
    return 1
  fi

  RUNNER_ISOLATION_AUDIT_OUTPUT="$RUNNER_ISOLATION_AUDIT_OUTPUT" \
    RUNNER_SMOKE_EVIDENCE_FILE="$RUNNER_SMOKE_EVIDENCE_FILE" \
    RUNNER_PRODUCTION_EVIDENCE_OUTPUT="$RUNNER_PRODUCTION_EVIDENCE_OUTPUT" \
    node --input-type=module <<'NODE'
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function normalizeIso(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`invalid timestamp in runner production evidence source: ${value}`);
  }
  return new Date(timestamp).toISOString();
}

function requireValue(value, name) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`missing ${name} in runner production evidence source`);
  }
  return value;
}

const auditPath = process.env.RUNNER_ISOLATION_AUDIT_OUTPUT;
const smokePath = process.env.RUNNER_SMOKE_EVIDENCE_FILE;
const outputPath = process.env.RUNNER_PRODUCTION_EVIDENCE_OUTPUT;
const auditBody = readJson(auditPath);
const smokeBody = readJson(smokePath);
const audit = auditBody.runnerIsolation ?? auditBody;
const runner = audit.evidence?.runner;
const smoke = smokeBody.runnerSmoke ?? smokeBody.smoke ?? smokeBody;

if (!runner || typeof runner !== "object" || Array.isArray(runner)) {
  throw new Error("runner isolation audit did not include evidence.runner");
}

const runnerEvidence = {
  ...runner,
  smokeEvidence: {
    source: smokePath,
    sha256: sha256File(smokePath),
    checkedAt: normalizeIso(smoke.observedAt ?? smoke.checkedAt ?? smoke.completedAt ?? smoke.requestedAt),
    repository: requireValue(smoke.repository, "runnerSmoke.repository"),
    workflow: requireValue(smoke.workflow, "runnerSmoke.workflow"),
    runId: requireValue(smoke.runId, "runnerSmoke.runId"),
    workflowRunUrl: requireValue(smoke.workflowRunUrl, "runnerSmoke.workflowRunUrl"),
  },
  auditEvidence: {
    source: auditPath,
    sha256: sha256File(auditPath),
    checkedAt: normalizeIso(audit.computedAt ?? audit.checkedAt),
    status: requireValue(audit.status, "runnerIsolation.status"),
    checkCount: Array.isArray(audit.checks) ? audit.checks.length : 0,
  },
};

writeFileSync(outputPath, `${JSON.stringify({ runner: runnerEvidence }, null, 2)}\n`, { mode: 0o600 });
NODE
  log "wrote production runner evidence to $RUNNER_PRODUCTION_EVIDENCE_OUTPUT"
}

main "$@"
