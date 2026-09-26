#!/usr/bin/env bash
set -euo pipefail

OS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ARTIFACT_DIR="${1:-${OS_ROOT}/linux/elizaos/artifacts/riscv64}"
if [ -z "${RISCV64_AGENT_RUNTIME_REPORT:-}" ] || [ -z "${RISCV64_AGENT_RUNTIME_TRANSCRIPT:-}" ]; then
    eliza_root="$(node "$OS_ROOT/scripts/eliza-source.ts")"
    output_directory="$(node --input-type=module -e '
        const { testOutputPath } = await import(process.argv[1]);
        console.log(testOutputPath("os-riscv64-runtime-artifact"));
    ' "$eliza_root/packages/scripts/lib/test-output.ts")"
fi
REPORT="${RISCV64_AGENT_RUNTIME_REPORT:-${output_directory}/report.json}"
TRANSCRIPT="${RISCV64_AGENT_RUNTIME_TRANSCRIPT:-${output_directory}/transcript.log}"

mkdir -p "$(dirname "${REPORT}")" "$(dirname "${TRANSCRIPT}")"
: >"${TRANSCRIPT}"

log() {
    printf '%s\n' "$*" | tee -a "${TRANSCRIPT}"
}

write_report() {
    python3 - "$REPORT" "$ARTIFACT_DIR" "$TRANSCRIPT" "$1" "${RUNTIME_MODE:-unknown}" "${2:-}" <<'PYREPORT'
from datetime import UTC, datetime
from pathlib import Path
import hashlib
import json
import sys

report, artifacts, transcript, status, runtime, detail = sys.argv[1:]
digest = hashlib.sha256()
with Path(transcript).open("rb") as handle:
    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
        digest.update(chunk)
data = {
    "schema": "eliza.os.linux.riscv64_agent_runtime_smoke.v1",
    "status": status,
    "claim_boundary": "static_staged_runtime_artifact_check_only_not_iso_boot_or_live_agent_health",
    "artifact_dir": artifacts,
    "transcript": transcript,
    "transcript_sha256": digest.hexdigest(),
    "runtime_mode": runtime,
    "generated_utc": datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
}
if status == "pass":
    data["failures"] = []
if detail:
    data["blocker"] = detail
Path(report).write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PYREPORT
}

fail() {
    log "artifact validation failed: $*"
    write_report BLOCKED "$*"
    exit 2
}

# A rerun must invalidate an earlier success before inspecting any inputs.
write_report checking

[ -s "${ARTIFACT_DIR}/elizaos-app/agent-bundle.js" ] ||
    fail "agent bundle missing from ${ARTIFACT_DIR}/elizaos-app/agent-bundle.js"
[ -s "${ARTIFACT_DIR}/elizaos-app.sha256" ] ||
    fail "elizaos-app.sha256 missing from ${ARTIFACT_DIR}"
[ -s "${ARTIFACT_DIR}/manifest.txt" ] ||
    fail "manifest.txt missing from ${ARTIFACT_DIR}"

(
    cd "${ARTIFACT_DIR}/elizaos-app"
    sha256sum -c "../elizaos-app.sha256"
) >>"${TRANSCRIPT}" 2>&1 || fail "elizaos-app.sha256 did not validate"

RUNTIME_MODE=node
if [ -x "${ARTIFACT_DIR}/bun" ]; then
    RUNTIME_MODE=bun
    (
        cd "${ARTIFACT_DIR}"
        sha256sum -c bun.sha256
    ) >>"${TRANSCRIPT}" 2>&1 || fail "bun.sha256 did not validate"
    log "elizaos-riscv64-bun-artifact-hash-verified"
else
    [ ! -e "${ARTIFACT_DIR}/bun" ] && [ ! -L "${ARTIFACT_DIR}/bun" ] || fail "staged Bun is not executable"
    grep -Fq "bun_file=node-shebang-agent-bundle-no-bun" "${ARTIFACT_DIR}/manifest.txt" ||
        fail "node-only manifest marker missing"
    grep -Fq 'import { createRequire as __elizaCreateRequire } from "node:module";' \
        "${ARTIFACT_DIR}/elizaos-app/agent-bundle.js" ||
        fail "node createRequire shim missing from agent bundle"
    log "elizaos-riscv64-node-agent-bundle-artifact-verified"
fi

log "elizaos-riscv64-agent-runtime-artifact-ok"

write_report pass
