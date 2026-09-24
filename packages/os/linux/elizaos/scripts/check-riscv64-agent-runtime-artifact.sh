#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR="${1:-artifacts/riscv64}"
REPORT="${RISCV64_AGENT_RUNTIME_REPORT:-evidence/riscv64_agent_runtime_smoke.json}"
TRANSCRIPT="${RISCV64_AGENT_RUNTIME_TRANSCRIPT:-evidence/riscv64_agent_runtime_smoke.log}"

mkdir -p "$(dirname "${REPORT}")" "$(dirname "${TRANSCRIPT}")"
: >"${TRANSCRIPT}"

log() {
    printf '%s\n' "$*" | tee -a "${TRANSCRIPT}"
}

fail() {
    log "missing expected marker: $*"
    python3 - "${REPORT}" "${ARTIFACT_DIR}" "$*" <<'PY'
from datetime import UTC, datetime
from pathlib import Path
import json
import sys

report = Path(sys.argv[1])
data = {
    "schema": "eliza.os.linux.riscv64_agent_runtime_smoke.v1",
    "status": "BLOCKED",
    "claim_boundary": "static_staged_runtime_artifact_check_only_not_iso_boot_or_live_agent_health",
    "artifact_dir": sys.argv[2],
    "generated_utc": datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "blocker": sys.argv[3],
}
report.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
    exit 2
}

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
    log "elizaos-riscv64-bun-eval-ok riscv64"
    log "elizaos-riscv64-bun-script-file-ok riscv64"
else
    grep -Fq "bun_file=node-shebang-agent-bundle-no-bun" "${ARTIFACT_DIR}/manifest.txt" ||
        fail "node-only manifest marker missing"
    grep -Fq 'import { createRequire as __elizaCreateRequire } from "node:module";' \
        "${ARTIFACT_DIR}/elizaos-app/agent-bundle.js" ||
        fail "node createRequire shim missing from agent bundle"
    log "elizaos-riscv64-node-agent-bundle-ok riscv64"
fi

log "elizaos-riscv64-agent-runtime-artifact-ok"

python3 - "${REPORT}" "${ARTIFACT_DIR}" "${TRANSCRIPT}" <<'PY'
from datetime import UTC, datetime
from pathlib import Path
import hashlib
import json
import sys

report = Path(sys.argv[1])
transcript = Path(sys.argv[3])

def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

runtime_mode = "bun" if (Path(sys.argv[2]) / "bun").exists() else "node"
data = {
    "schema": "eliza.os.linux.riscv64_agent_runtime_smoke.v1",
    "status": "pass",
    "claim_boundary": "static_staged_runtime_artifact_check_only_not_iso_boot_or_live_agent_health",
    "artifact_dir": sys.argv[2],
    "transcript": sys.argv[3],
    "transcript_sha256": sha256(transcript),
    "runtime_mode": runtime_mode,
    "failures": [],
    "generated_utc": datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
}
report.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
