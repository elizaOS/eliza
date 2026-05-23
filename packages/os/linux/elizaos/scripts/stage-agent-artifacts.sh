#!/usr/bin/env bash
# Stage a real elizaOS agent bundle and target Bun runtime for live-build.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
LINUX_DIR="${ROOT}/packages/os/linux/elizaos"
AGENT_DIR="${ROOT}/packages/agent"

arch_from_uname() {
    case "$(uname -m)" in
        x86_64) echo amd64 ;;
        aarch64|arm64) echo arm64 ;;
        riscv64) echo riscv64 ;;
        *) echo "unsupported host arch: $(uname -m)" >&2; exit 64 ;;
    esac
}

usage() {
    cat <<EOF
Usage: $0 [--arch amd64|arm64|riscv64] [--bun PATH] [--out DIR] [--skip-build]

Stages:
  bun
  bun.sha256
  elizaos-app/
  elizaos-app.sha256
  vector.tar.gz
  fuzzystrmatch.tar.gz
  elizaos-root-assets.sha256

For amd64, --bun defaults to the first bun on PATH. For arm64 and riscv64,
provide --bun or ELIZAOS_BUN_SOURCE with a verified target-architecture binary.
EOF
}

ARCH="${ELIZAOS_ARCH:-$(arch_from_uname)}"
BUN_SOURCE="${ELIZAOS_BUN_SOURCE:-}"
OUT_DIR=""
SKIP_BUILD=0

while [ "$#" -gt 0 ]; do
    case "$1" in
        --arch)
            ARCH="${2:?missing --arch value}"
            shift 2
            ;;
        --bun)
            BUN_SOURCE="${2:?missing --bun value}"
            shift 2
            ;;
        --out)
            OUT_DIR="${2:?missing --out value}"
            shift 2
            ;;
        --skip-build)
            SKIP_BUILD=1
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

case "${ARCH}" in
    amd64|arm64|riscv64) ;;
    *) echo "unsupported target arch: ${ARCH}" >&2; exit 64 ;;
esac

if [ -z "${OUT_DIR}" ]; then
    OUT_DIR="${LINUX_DIR}/artifacts/${ARCH}"
fi

if [ -z "${BUN_SOURCE}" ] && [ "${ARCH}" = "amd64" ]; then
    BUN_SOURCE="$(command -v bun || true)"
fi

if [ -z "${BUN_SOURCE}" ]; then
    echo "ERROR: --bun or ELIZAOS_BUN_SOURCE is required for ${ARCH}." >&2
    exit 66
fi

if [ ! -x "${BUN_SOURCE}" ]; then
    echo "ERROR: Bun source is not executable: ${BUN_SOURCE}" >&2
    exit 66
fi

BUN_FILE="$(file -b "${BUN_SOURCE}")"
case "${ARCH}:${BUN_FILE}" in
    amd64:*x86-64*) ;;
    arm64:*aarch64*|arm64:*ARM\ aarch64*) ;;
    riscv64:*RISC-V*) ;;
    *)
        echo "ERROR: Bun source architecture does not match ${ARCH}: ${BUN_FILE}" >&2
        exit 66
        ;;
esac

if [ "${SKIP_BUILD}" -eq 0 ]; then
    bun run --cwd "${AGENT_DIR}" build:mobile
fi

if [ ! -f "${AGENT_DIR}/dist-mobile/agent-bundle.js" ]; then
    echo "ERROR: missing ${AGENT_DIR}/dist-mobile/agent-bundle.js" >&2
    exit 65
fi

rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}/elizaos-app"
install -m 0755 "${BUN_SOURCE}" "${OUT_DIR}/bun"
cp -a "${AGENT_DIR}/dist-mobile/." "${OUT_DIR}/elizaos-app/"
for asset in vector.tar.gz fuzzystrmatch.tar.gz; do
    if [ -f "${AGENT_DIR}/dist-mobile/${asset}" ]; then
        install -m 0644 "${AGENT_DIR}/dist-mobile/${asset}" "${OUT_DIR}/${asset}"
    fi
done

(
    cd "${OUT_DIR}"
    sha256sum bun > bun.sha256
    find vector.tar.gz fuzzystrmatch.tar.gz -type f -print0 | sort -z | xargs -0 sha256sum > elizaos-root-assets.sha256
)
(
    cd "${OUT_DIR}/elizaos-app"
    find . -type f -print0 | sort -z | xargs -0 sha256sum > "${OUT_DIR}/elizaos-app.sha256"
)

cat > "${OUT_DIR}/manifest.txt" <<EOF
arch=${ARCH}
bun_source=${BUN_SOURCE}
bun_file=${BUN_FILE}
agent_bundle=${AGENT_DIR}/dist-mobile/agent-bundle.js
EOF

echo "staged elizaOS agent artifacts: ${OUT_DIR}"
