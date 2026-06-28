#!/usr/bin/env bash
# Bootstrap the canonical Linux container that hosts the LLVM stage-1+stage-2
# build for the e1 RISC-V toolchain.
#
# Two-step process:
#   1. Build the base chip image (packages/chip/Dockerfile) tagged
#      eliza-chip:linux-x86_64. This carries the apt manifest snapshot consumed
#      by scripts/record_tool_versions.sh.
#   2. Build the LLVM build image (compiler/llvm-build/Dockerfile) tagged
#      eliza-chip:llvm-build. This layer adds lld + ccache + lit + libxml2 +
#      libzstd + zlib + swig on top of the base image.
#
# Fails closed if:
#   - docker is not on PATH
#   - the chip repo root cannot be located (must run from packages/chip)
#   - either docker build invocation fails
#
# Outputs:
#   build/reports/compiler/llvm-container-bootstrap.json
#     {
#       "schema": "eliza.compiler.llvm_container_bootstrap.v1",
#       "base_image": { "tag": "eliza-chip:linux-x86_64", "id": "sha256:..." },
#       "build_image": { "tag": "eliza-chip:llvm-build", "id": "sha256:..." },
#       "bootstrap_at_utc": "<UTC timestamp>"
#     }
#
# Status terms: `STATUS: <status> bootstrap.<stage>`.
set -euo pipefail

repo_dir="$(CDPATH=; cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$repo_dir"

BASE_TAG="${ELIZA_CHIP_BASE_TAG:-eliza-chip:linux-x86_64}"
BUILD_TAG="${ELIZA_CHIP_LLVM_TAG:-eliza-chip:llvm-build}"
REPORT_DIR="build/reports/compiler"
REPORT_PATH="$REPORT_DIR/llvm-container-bootstrap.json"

mkdir -p "$REPORT_DIR"

emit_status() {
    printf 'STATUS: %s %s\n' "$1" "$2"
}

disk_free_gib() {
    df -BG --output=avail / 2>/dev/null | tail -n 1 | tr -dc '0-9'
}

block_with_reason() {
    local stage="$1"
    local reason="$2"
    local log_hint="${3:-}"
    emit_status "BLOCKED" "$stage"
    local free_gib
    free_gib="$(disk_free_gib)"
    python3 - "$REPORT_PATH" "$stage" "$reason" "$log_hint" "${free_gib:-0}" <<'PY'
import json, os, sys, datetime
report_path, stage, reason, log_hint, free_gib = sys.argv[1:6]
payload = {
    "schema": "eliza.compiler.llvm_container_bootstrap.v1",
    "status": "BLOCKED",
    "blocked_stage": stage,
    "blocked_reason": reason,
    "bootstrap_attempted_at_utc": datetime.datetime.now(datetime.UTC).isoformat(),
    "host_capabilities": {
        "docker_present": stage not in ("docker_missing_on_host",),
        "docker_daemon_reachable": stage
        not in ("docker_missing_on_host", "docker_daemon_unreachable"),
        "host_arch": os.uname().machine,
        "host_os": os.uname().sysname,
        "disk_free_gib_at_attempt": int(free_gib or 0),
    },
}
if log_hint:
    payload["evidence_paths"] = {"log": log_hint}
os.makedirs(os.path.dirname(report_path), exist_ok=True)
with open(report_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2, sort_keys=True)
    handle.write("\n")
PY
    echo "bootstrap_llvm_container: BLOCKED at $stage: $reason" >&2
    exit 2
}

if ! command -v docker >/dev/null 2>&1; then
    block_with_reason "docker_missing_on_host" \
        "docker binary not on PATH; install Docker Engine 24+ or run inside an existing eliza-chip:linux-x86_64 container"
fi

if ! docker info >/dev/null 2>&1; then
    block_with_reason "docker_daemon_unreachable" \
        "docker info failed; daemon not running or current user lacks access to the docker socket"
fi

emit_status "PASS" "docker_present"

base_dockerfile="$repo_dir/Dockerfile"
llvm_dockerfile="$repo_dir/compiler/llvm-build/Dockerfile"

if [ ! -f "$base_dockerfile" ]; then
    block_with_reason "base_dockerfile_missing" \
        "expected canonical container Dockerfile at $base_dockerfile"
fi
if [ ! -f "$llvm_dockerfile" ]; then
    block_with_reason "llvm_dockerfile_missing" \
        "expected LLVM-build Dockerfile at $llvm_dockerfile"
fi

emit_status "PASS" "dockerfiles_present"

build_base=1
if docker image inspect "$BASE_TAG" >/dev/null 2>&1; then
    if [ "${FORCE_REBUILD:-0}" = "1" ]; then
        emit_status "PASS" "base_image_cached_but_force_rebuild"
    else
        emit_status "PASS" "base_image_cached"
        build_base=0
    fi
fi

if [ "$build_base" = "1" ]; then
    emit_status "PASS" "base_image_build_begin"
    base_build_log="$REPORT_DIR/llvm-container-base-build.log"
    set +e
    docker build -f "$base_dockerfile" -t "$BASE_TAG" "$repo_dir" >"$base_build_log" 2>&1
    base_rc=$?
    set -e
    if [ "$base_rc" -ne 0 ] || ! docker image inspect "$BASE_TAG" >/dev/null 2>&1; then
        block_with_reason "base_image_build_failed" \
            "docker build of $BASE_TAG from $base_dockerfile failed (exit=$base_rc); see log for full output" \
            "$base_build_log"
    fi
    emit_status "PASS" "base_image_build_complete"
fi

base_id="$(docker image inspect --format '{{.Id}}' "$BASE_TAG")"

build_llvm=1
if docker image inspect "$BUILD_TAG" >/dev/null 2>&1; then
    if [ "${FORCE_REBUILD:-0}" = "1" ]; then
        emit_status "PASS" "build_image_cached_but_force_rebuild"
    else
        emit_status "PASS" "build_image_cached"
        build_llvm=0
    fi
fi

if [ "$build_llvm" = "1" ]; then
    emit_status "PASS" "build_image_build_begin"
    build_log="$REPORT_DIR/llvm-container-build-build.log"
    set +e
    docker build \
        --build-arg "BASE_IMAGE=$BASE_TAG" \
        -f "$llvm_dockerfile" \
        -t "$BUILD_TAG" \
        "$repo_dir" >"$build_log" 2>&1
    build_rc=$?
    set -e
    if [ "$build_rc" -ne 0 ] || ! docker image inspect "$BUILD_TAG" >/dev/null 2>&1; then
        block_with_reason "build_image_build_failed" \
            "docker build of $BUILD_TAG from $llvm_dockerfile failed (exit=$build_rc); see log for full output" \
            "$build_log"
    fi
    emit_status "PASS" "build_image_build_complete"
fi

build_id="$(docker image inspect --format '{{.Id}}' "$BUILD_TAG")"

python3 - "$REPORT_PATH" "$BASE_TAG" "$base_id" "$BUILD_TAG" "$build_id" <<'PY'
import json, os, sys, datetime
report_path, base_tag, base_id, build_tag, build_id = sys.argv[1:6]
payload = {
    "schema": "eliza.compiler.llvm_container_bootstrap.v1",
    "status": "PASS",
    "base_image": {"tag": base_tag, "id": base_id},
    "build_image": {"tag": build_tag, "id": build_id},
    "bootstrap_at_utc": datetime.datetime.now(datetime.UTC).isoformat(),
}
os.makedirs(os.path.dirname(report_path), exist_ok=True)
with open(report_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2, sort_keys=True)
    handle.write("\n")
PY
emit_status "PASS" "bootstrap_complete"

echo ""
echo "Next step: enter the container and run the two-stage LLVM build:"
echo "  docker run --rm -it -v $repo_dir:/work -w /work $BUILD_TAG \\"
echo "      scripts/build_llvm_riscv.sh"
