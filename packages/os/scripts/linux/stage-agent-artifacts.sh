#!/usr/bin/env bash
set -euo pipefail

OS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LINUX_DIR="${OS_ROOT}/linux"
RM_PATH_RECURSIVE_SCRIPT="${OS_ROOT}/../scripts/rm-path-recursive.ts"

ARCH="amd64"
SKIP_BUILD=0
OUT=""
BUN_SOURCE=""

usage() {
    cat <<'EOF'
usage: stage-agent-artifacts.sh --arch <amd64|arm64> [options]

Options:
  --skip-build
  --out <dir>
  --bun-source <path>
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --arch|--out|--bun-source)
            if [ "$#" -lt 2 ] || [ -z "$2" ] || [[ "$2" == --* ]]; then
                echo "ERROR: $1 requires a value" >&2
                exit 64
            fi
            ;;
    esac
    case "$1" in
        --arch)
            ARCH="$2"
            shift 2
            ;;
        --skip-build)
            SKIP_BUILD=1
            shift
            ;;
        --out)
            OUT="$2"
            shift 2
            ;;
        --bun-source)
            BUN_SOURCE="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "ERROR: unknown option $1" >&2
            usage >&2
            exit 64
            ;;
    esac
done

case "${ARCH}" in
    amd64|arm64) ;;
    *)
        echo "ERROR: unsupported arch ${ARCH}" >&2
        exit 64
        ;;
esac

if [ -z "${OUT}" ]; then
    OUT="${LINUX_DIR}/artifacts/${ARCH}"
fi

ELIZA_ROOT="$(node "$OS_ROOT/scripts/eliza-source.ts")"
AGENT_BUNDLE="${ELIZA_ROOT}/packages/agent/dist-mobile/agent-bundle.js"
if [ "${SKIP_BUILD}" != "1" ]; then
    (cd "${ELIZA_ROOT}" && bun run --cwd packages/agent build:mobile)
fi

if [ ! -s "${AGENT_BUNDLE}" ]; then
    echo "ERROR: missing built agent bundle: ${AGENT_BUNDLE}" >&2
    exit 65
fi

sha256_file() {
    sha256sum "$1" | awk '{print $1}'
}

rm_path_recursive() {
    if [ ! -r "${RM_PATH_RECURSIVE_SCRIPT}" ]; then
        echo "ERROR: recursive cleanup helper not found at ${RM_PATH_RECURSIVE_SCRIPT}" >&2
        return 1
    fi
    node "${RM_PATH_RECURSIVE_SCRIPT}" "$@"
}

copy_agent_bundle() {
    mkdir -p "${OUT}/elizaos-app"
    python3 - "${AGENT_BUNDLE}" "${OUT}/elizaos-app/agent-bundle.js" <<'PY'
from pathlib import Path
import sys

source = Path(sys.argv[1])
dest = Path(sys.argv[2])
text = source.read_text(encoding="utf-8")
shim = (
    'import { createRequire as __elizaCreateRequire } from "node:module";\n'
    "const __elizaNodeRequire = import.meta.require ? import.meta.require : "
    "__elizaCreateRequire(import.meta.url);\n"
    "import.meta.require = __elizaNodeRequire;\n"
)
if 'import { createRequire as __elizaCreateRequire } from "node:module";' not in text:
    if text.startswith("#!"):
        first_line, _, body = text.partition("\n")
        text = first_line + "\n" + shim + body
    else:
        text = shim + text
dest.write_text(text, encoding="utf-8")
PY
}

write_app_hashes() {
    (
        cd "${OUT}/elizaos-app"
        find . -type f -print0 | sort -z | xargs -0 sha256sum
    ) >"${OUT}/elizaos-app.sha256"
    (
        cd "${OUT}"
        find . -maxdepth 1 -type f ! -name 'elizaos-root-assets.sha256' -print0 |
            sort -z |
            xargs -0 --no-run-if-empty sha256sum
    ) >"${OUT}/elizaos-root-assets.sha256"
}

write_manifest() {
    local bun_file="$1"
    local bun_sha="$2"
    {
        echo "arch=${ARCH}"
        echo "bun_source=${BUN_SOURCE}"
        echo "bun_source_url="
        echo "bun_source_sha256="
        echo "bun_staged_sha256=${bun_sha}"
        echo "bun_file=${bun_file}"
        echo "agent_bundle=${AGENT_BUNDLE}"
    } >"${OUT}/manifest.txt"
}

# Build beside the destination so failed validation preserves its old contents.
FINAL_OUT="$(python3 - "$OUT" "$OS_ROOT" "$ELIZA_ROOT" "$AGENT_BUNDLE" <<'PY'
from pathlib import Path
import sys
out = Path(sys.argv[1]).absolute()
if out.is_symlink():
    raise SystemExit("ERROR: output directory must not be a symlink")
if out.exists() and not out.is_dir():
    raise SystemExit("ERROR: output must be a directory")
out = out.resolve()
for source in sys.argv[2:]:
    if Path(source).resolve().is_relative_to(out):
        raise SystemExit(f"ERROR: output would remove source input: {source}")
print(out)
PY
)"
mkdir -p "$(dirname "$FINAL_OUT")"
STAGING="$(mktemp -d "$(dirname "$FINAL_OUT")/.elizaos-stage.XXXXXX")"
BACKUP=""
COMMITTED=0
cleanup() {
    local rc=$?
    trap - EXIT
    if [ -n "$BACKUP" ] && [ -e "$BACKUP/previous" ]; then
        if [ "$COMMITTED" = 1 ]; then
            rm_path_recursive "$BACKUP" || rc=1
        elif [ ! -e "$FINAL_OUT" ]; then
            mv -- "$BACKUP/previous" "$FINAL_OUT" || rc=1
        else
            echo "ERROR: previous artifacts retained at $BACKUP/previous" >&2
            rc=1
        fi
    fi
    if [ -d "$BACKUP" ] && [ ! -e "$BACKUP/previous" ]; then
        rmdir -- "$BACKUP" || rc=1
    fi
    rm_path_recursive "$STAGING" || rc=1
    exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
OUT="$STAGING"
copy_agent_bundle

if [ -n "${BUN_SOURCE}" ]; then
    install -m 0755 "${BUN_SOURCE}" "${OUT}/bun"
    (cd "${OUT}" && sha256sum bun > bun.sha256)
    write_manifest "$(file -b "${BUN_SOURCE}")" "$(sha256_file "${OUT}/bun")"
else
    write_manifest "node-shebang-agent-bundle-no-bun" ""
fi

write_app_hashes
if [ -e "$FINAL_OUT" ]; then
    BACKUP="$(mktemp -d "$(dirname "$FINAL_OUT")/.elizaos-stage-backup.XXXXXX")"
    mv -- "$FINAL_OUT" "$BACKUP/previous"
fi
mv -T -- "$OUT" "$FINAL_OUT"
COMMITTED=1
echo "staged ${ARCH} agent artifacts: ${FINAL_OUT}"
