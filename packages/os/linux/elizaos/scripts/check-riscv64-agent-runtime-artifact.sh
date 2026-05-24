#!/usr/bin/env bash
# Smoke the staged riscv64 runtime + agent artifact before spending an ISO build.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VARIANT_DIR="$(cd "${HERE}/.." && pwd)"
REPO_ROOT="$(cd "${VARIANT_DIR}/../../../.." && pwd)"

ARTIFACTS="${VARIANT_DIR}/artifacts/riscv64"
REPORT="${VARIANT_DIR}/evidence/riscv64_agent_runtime_smoke.json"
TRANSCRIPT="${VARIANT_DIR}/evidence/riscv64_agent_runtime_smoke.log"
DOCKER_IMAGE="${ELIZAOS_RISCV64_BUN_SMOKE_IMAGE:-eliza/bun-riscv64-builder}"
AGENT_ENTRYPOINT_TIMEOUT="${ELIZAOS_RISCV64_AGENT_ENTRYPOINT_TIMEOUT:-90s}"
INNER=0

usage() {
    sed -n '1,40p' "${BASH_SOURCE[0]}"
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --artifacts)
            ARTIFACTS="${2:?missing --artifacts value}"
            shift 2
            ;;
        --report)
            REPORT="${2:?missing --report value}"
            shift 2
            ;;
        --transcript)
            TRANSCRIPT="${2:?missing --transcript value}"
            shift 2
            ;;
        --docker-image)
            DOCKER_IMAGE="${2:?missing --docker-image value}"
            shift 2
            ;;
        --inner)
            INNER=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "unknown argument: $1" >&2
            usage >&2
            exit 64
            ;;
    esac
done

if [ "${INNER}" -eq 0 ] && ! command -v qemu-riscv64-static >/dev/null 2>&1; then
    command -v docker >/dev/null 2>&1 || {
        echo "ERROR: qemu-riscv64-static not on PATH and docker is unavailable." >&2
        exit 127
    }
    mkdir -p "$(dirname "${REPORT}")" "$(dirname "${TRANSCRIPT}")"
    exec docker run --rm \
        -v "${REPO_ROOT}:/repo:ro" \
        -v "$(cd "$(dirname "${ARTIFACTS}")" && pwd):/artifact-parent:ro" \
        -v "$(cd "$(dirname "${REPORT}")" && pwd):/report-dir:rw" \
        -v "$(cd "$(dirname "${TRANSCRIPT}")" && pwd):/transcript-dir:rw" \
        --entrypoint bash \
        "${DOCKER_IMAGE}" \
        /repo/packages/os/linux/elizaos/scripts/check-riscv64-agent-runtime-artifact.sh \
            --inner \
            --artifacts "/artifact-parent/$(basename "${ARTIFACTS}")" \
            --report "/report-dir/$(basename "${REPORT}")" \
            --transcript "/transcript-dir/$(basename "${TRANSCRIPT}")"
fi

mkdir -p "$(dirname "${REPORT}")" "$(dirname "${TRANSCRIPT}")"
: > "${TRANSCRIPT}"

LD_MUSL="${ARTIFACTS}/elizaos-app/musl-runtime/ld-musl-riscv64.so.1"
BUN_BIN="${ARTIFACTS}/elizaos-app/musl-runtime/bun"
ICU_DATA_DIR="${ARTIFACTS}/elizaos-app/musl-runtime/icu"
AGENT_BUNDLE="${ARTIFACTS}/elizaos-app/agent-bundle.js"
BUN_PROVENANCE="${ARTIFACTS}/riscv64-bun-provenance.json"
BUN_VERSION_JSON="${REPO_ROOT}/packages/app-core/scripts/bun-riscv64/bun-version.json"
RUNTIME_MODE="bun"

if [ ! -e "${BUN_BIN}" ] && [ ! -e "${ARTIFACTS}/bun" ]; then
    RUNTIME_MODE="node"
fi

failures=()
if [ "${RUNTIME_MODE}" = "node" ]; then
    if [ ! -f "${AGENT_BUNDLE}" ]; then
        failures+=("missing required artifact: ${AGENT_BUNDLE}")
    elif ! head -n 1 "${AGENT_BUNDLE}" | grep -Eq '^#! */usr/bin/env node$|^#! */usr/bin/node$'; then
        failures+=("node-only riscv64 agent bundle does not have a node shebang: ${AGENT_BUNDLE}")
    fi
    if [ -e "${ARTIFACTS}/bun" ] || [ -e "${BUN_BIN}" ] || [ -e "${BUN_PROVENANCE}" ]; then
        failures+=("node-only riscv64 staging must not include Bun artifacts or Bun provenance")
    fi
    {
        printf '## runtime_mode: node\n'
        printf '## agent_bundle: %s\n' "${AGENT_BUNDLE}"
        printf '## agent_bundle_shebang: %s\n' "$(head -n 1 "${AGENT_BUNDLE}" 2>/dev/null || true)"
        printf 'elizaos-riscv64-node-agent-bundle-staged\n'
    } >> "${TRANSCRIPT}"
else
    for required in "${LD_MUSL}" "${BUN_BIN}" "${AGENT_BUNDLE}"; do
        if [ ! -e "${required}" ]; then
            failures+=("missing required artifact: ${required}")
        fi
    done
    if [ ! -f "${BUN_PROVENANCE}" ]; then
        failures+=("missing riscv64 Bun stage provenance: ${BUN_PROVENANCE}")
    fi
    if [ "${#failures[@]}" -gt 0 ]; then
        printf '%s\n' "${failures[@]}" >> "${TRANSCRIPT}"
    else
        export ELIZAOS_RISCV64_BUN_PROVENANCE="${BUN_PROVENANCE}"
        export ELIZAOS_RISCV64_BUN_VERSION_JSON="${BUN_VERSION_JSON}"
        export ELIZAOS_RISCV64_BUN_BIN="${BUN_BIN}"
        while IFS= read -r line; do
            [ -n "${line}" ] && failures+=("${line}")
        done < <(python3 - <<'PY'
import hashlib
import json
import os
from pathlib import Path

provenance = Path(os.environ["ELIZAOS_RISCV64_BUN_PROVENANCE"]).resolve()
version_json = Path(os.environ["ELIZAOS_RISCV64_BUN_VERSION_JSON"]).resolve()
bun_bin = Path(os.environ["ELIZAOS_RISCV64_BUN_BIN"]).resolve()
repo_root = version_json.parents[4]
script_dir = version_json.parent


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(repo_root).as_posix()
    except ValueError:
        return str(path)


def emit(message: str) -> None:
    print(message)


try:
    data = json.loads(provenance.read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError) as exc:
    emit(f"invalid riscv64 Bun stage provenance: {provenance}: {exc}")
    raise SystemExit(0)

if data.get("schema") != "eliza.os.linux.riscv64_bun_stage_provenance.v1":
    emit(f"riscv64 Bun stage provenance schema mismatch: {data.get('schema')!r}")

inputs = data.get("inputs")
if not isinstance(inputs, dict):
    emit("riscv64 Bun stage provenance has no input hash map")
    inputs = {}

current_inputs = {rel(version_json): sha256_file(version_json)}
try:
    version_data = json.loads(version_json.read_text(encoding="utf-8"))
except json.JSONDecodeError as exc:
    emit(f"current riscv64 Bun version manifest is invalid JSON: {exc}")
    version_data = {}

patch_series = version_data.get("patch_series", {}) if isinstance(version_data, dict) else {}
for key, folder in (
    ("bun_patches", "bun-patches"),
    ("webkit_patches", "webkit-patches"),
    ("webkit_recipes", "webkit-patches"),
):
    entries = patch_series.get(key, {}) if isinstance(patch_series, dict) else {}
    if not isinstance(entries, dict):
        continue
    for name in sorted(entries):
        path = script_dir / folder / name
        if not path.is_file():
            emit(f"current riscv64 Bun patch input is missing: {rel(path)}")
            continue
        current_inputs[rel(path)] = sha256_file(path)

missing = sorted(set(current_inputs) - set(inputs))
stale = sorted(
    path for path, digest in current_inputs.items() if inputs.get(path) not in (None, digest)
)
extra = sorted(set(inputs) - set(current_inputs))
if missing:
    emit("riscv64 Bun stage provenance is missing current input(s): " + ", ".join(missing[:6]))
if stale:
    emit("riscv64 Bun stage provenance has stale input hash(es): " + ", ".join(stale[:6]))
if extra:
    emit("riscv64 Bun stage provenance records non-current input(s): " + ", ".join(extra[:6]))

artifact = data.get("artifact", {})
if not isinstance(artifact, dict):
    emit("riscv64 Bun stage provenance has no artifact block")
else:
    recorded_bun_sha = artifact.get("staged_bun_sha256")
    current_bun_sha = sha256_file(bun_bin)
    if recorded_bun_sha != current_bun_sha:
        emit(
            "riscv64 Bun stage provenance staged_bun_sha256 does not match "
            f"the staged binary: recorded={recorded_bun_sha!r} current={current_bun_sha}"
        )
PY
        )
        if [ "${#failures[@]}" -gt 0 ]; then
            printf '%s\n' "${failures[@]}" >> "${TRANSCRIPT}"
        fi
        if [ -d "${ICU_DATA_DIR}" ]; then
            export ICU_DATA="${ICU_DATA_DIR}"
        fi
        QEMU=(qemu-riscv64-static "${LD_MUSL}" --library-path "${ARTIFACTS}/elizaos-app/musl-runtime" "${BUN_BIN}")

        run_probe() {
            local name="$1"
            local expected_marker="$2"
            shift 2
            local rc=0
            {
                printf '\n## probe: %s\n' "${name}"
                printf '## command:'
                printf ' %q' "${QEMU[@]}" "$@"
                printf '\n'
            } >> "${TRANSCRIPT}"
            local timeout_s="20s"
            if [ "${name}" = "agent-entrypoint" ]; then
                timeout_s="${AGENT_ENTRYPOINT_TIMEOUT}"
            fi
            timeout "${timeout_s}" "${QEMU[@]}" "$@" >> "${TRANSCRIPT}" 2>&1 || rc=$?
            printf '## rc: %s\n' "${rc}" >> "${TRANSCRIPT}"
            if [ "${rc}" -ne 0 ]; then
                failures+=("${name} failed rc=${rc}")
            elif [ -n "${expected_marker}" ] \
                && ! awk -v probe="${name}" -v marker="${expected_marker}" '
                    $0 == "## probe: " probe {flag=1; next}
                    /^## probe: / {flag=0}
                    flag && index($0, marker) {found=1}
                    END {exit found ? 0 : 1}
                ' "${TRANSCRIPT}"; then
                failures+=("${name} missing expected marker: ${expected_marker}")
            fi
        }

        run_probe "bun-version" "" --version
        run_probe "bun-eval" "elizaos-riscv64-bun-eval-ok riscv64" -e 'console.log("elizaos-riscv64-bun-eval-ok", process.arch)'
        run_probe "bun-nfkc" "elizaos-riscv64-bun-nfkc-ok líder" -e 'console.log("elizaos-riscv64-bun-nfkc-ok", "líder".normalize("NFKC"))'
        SMALL_JS="$(mktemp --suffix=.js)"
        printf 'console.log("elizaos-riscv64-bun-script-file-ok", process.arch)\n' > "${SMALL_JS}"
        run_probe "bun-script-file" "elizaos-riscv64-bun-script-file-ok riscv64" "${SMALL_JS}"
        rm -f "${SMALL_JS}"
        run_probe "agent-entrypoint" "" "${AGENT_BUNDLE}" tui-smoke --api http://127.0.0.1:31337
    fi
fi

if grep -E -q 'unhandled signal 4|Illegal instruction|SIGILL' "${TRANSCRIPT}"; then
    failures+=("riscv64 Bun trapped with illegal instruction")
fi
if grep -F -q '## probe: bun-script-file' "${TRANSCRIPT}" \
    && awk '/## probe: bun-script-file/{flag=1; next}/## probe:/{flag=0}flag' "${TRANSCRIPT}" \
        | grep -F -q 'Module not found'; then
    failures+=("riscv64 Bun cannot execute JS file entrypoints under qemu-user")
fi
if awk '/## probe: agent-entrypoint/{flag=1; next}/## probe:/{flag=0}flag' "${TRANSCRIPT}" \
    | grep -F -q 'Module not found'; then
    failures+=("riscv64 Bun could not load the staged agent bundle")
fi

status="pass"
if [ "${#failures[@]}" -gt 0 ]; then
    status="fail"
fi

export REPORT
export STATUS="${status}"
export RUNTIME_MODE
export ARTIFACTS
export TRANSCRIPT
export FAILURES_JSON
FAILURES_JSON="$(printf '%s\n' "${failures[@]+"${failures[@]}"}" | python3 -c 'import json,sys; print(json.dumps([line for line in sys.stdin.read().splitlines() if line]))')"
export TRANSCRIPT_SHA256
TRANSCRIPT_SHA256="$(sha256sum "${TRANSCRIPT}" | awk '{print $1}')"

python3 - <<'PY'
import json
import os
from datetime import datetime, timezone

doc = {
    "schema": "eliza.os.linux.riscv64_agent_runtime_smoke.v1",
    "generated_utc": datetime.now(timezone.utc).isoformat(),
    "status": os.environ["STATUS"],
    "runtime_mode": os.environ["RUNTIME_MODE"],
    "artifacts": os.environ["ARTIFACTS"],
    "transcript": os.environ["TRANSCRIPT"],
    "transcript_sha256": os.environ["TRANSCRIPT_SHA256"],
    "failures": json.loads(os.environ["FAILURES_JSON"]),
    "claim_boundary": "qemu-user smoke of staged riscv64 Bun or static validation of node-shebang agent bundle; not full ISO boot evidence",
}
with open(os.environ["REPORT"], "w", encoding="utf-8") as fh:
    json.dump(doc, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY

echo "riscv64 agent runtime smoke: ${status}"
echo "  transcript: ${TRANSCRIPT}"
echo "  report: ${REPORT}"
if [ "${status}" != "pass" ]; then
    printf '  - %s\n' "${failures[@]}" >&2
    exit 1
fi
