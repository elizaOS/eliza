#!/usr/bin/env bash
set -euo pipefail

OS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LINUX_DIR="${OS_ROOT}/linux/elizaos"
RM_PATH_RECURSIVE_SCRIPT="${OS_ROOT}/scripts/rm-path-recursive.ts"

ARCH="amd64"
SKIP_BUILD=0
OUT=""
BUN_SOURCE=""
RISCV64_BUN_ZIP="${OS_ROOT}/toolchains/bun-riscv64/dist/bun-linux-riscv64-musl.zip"
RISCV64_MUSL_RUNTIME="${LINUX_DIR}/artifacts/riscv64/elizaos-app/musl-runtime"
RISCV64_ICU_DATA=""
RISCV64_BUN_ZIP_EXPLICIT=0

usage() {
    cat <<'EOF'
usage: stage-agent-artifacts.sh --arch <amd64|arm64|riscv64> [options]

Options:
  --skip-build
  --out <dir>
  --bun-source <path>
  --riscv64-bun-zip <path>
  --riscv64-musl-runtime <dir>
  --riscv64-icu-data <dir>
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --arch|--out|--bun-source|--riscv64-bun-zip|--riscv64-musl-runtime|--riscv64-icu-data)
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
        --riscv64-bun-zip)
            RISCV64_BUN_ZIP="$2"
            RISCV64_BUN_ZIP_EXPLICIT=1
            shift 2
            ;;
        --riscv64-musl-runtime)
            RISCV64_MUSL_RUNTIME="$2"
            shift 2
            ;;
        --riscv64-icu-data)
            RISCV64_ICU_DATA="$2"
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
    amd64|arm64|riscv64) ;;
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
        echo "bun_riscv64_zip=${RISCV64_BUN_ZIP}"
        echo "riscv64_musl_runtime=${RISCV64_MUSL_RUNTIME}"
        echo "riscv64_icu_data=${RISCV64_ICU_DATA}"
        echo "bun_source_url="
        echo "bun_source_sha256="
        echo "bun_staged_sha256=${bun_sha}"
        echo "bun_file=${bun_file}"
        echo "agent_bundle=${AGENT_BUNDLE}"
    } >"${OUT}/manifest.txt"
}

write_riscv64_provenance() {
    local zip_path="$1"
    local staged_bun="$2"
    python3 - "${OS_ROOT}" "${OUT}/riscv64-bun-provenance.json" "${zip_path}" "${staged_bun}" "${RISCV64_MUSL_RUNTIME}" "${RISCV64_ICU_DATA}" "${FINAL_OUT}/elizaos-app/musl-runtime/bun" <<'PY'
from datetime import UTC, datetime
from pathlib import Path
import hashlib
import json
import sys

root = Path(sys.argv[1]).resolve()
out = Path(sys.argv[2])
zip_path = Path(sys.argv[3]).resolve()
staged_bun = Path(sys.argv[4]).resolve()
musl_runtime = sys.argv[5]
icu_data = sys.argv[6]


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


input_globs = [
    "toolchains/bun-riscv64/bun-version.json",
    "toolchains/bun-riscv64/bun-patches/*.patch",
    "toolchains/bun-riscv64/webkit-patches/*",
]
inputs = {}
for pattern in input_globs:
    for path in sorted(root.glob(pattern)):
        if path.is_file():
            inputs[rel(path)] = digest(path)

data = {
    "schema": "eliza.os.linux.riscv64_bun_stage_provenance.v1",
    "claim_boundary": "staged riscv64 Bun artifact provenance for Debian/AOSP shared userland runtime; not a boot or agent-health runtime claim",
    "producer": "scripts/linux/stage-agent-artifacts.sh",
    "generated_utc": datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "inputs": inputs,
    "artifact": {
        "zip_path": str(zip_path),
        "zip_sha256": digest(zip_path),
        "musl_runtime": musl_runtime,
        "icu_data": icu_data,
        "staged_bun": rel(Path(sys.argv[7])),
        "staged_bun_sha256": digest(staged_bun),
    },
}
out.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
}

# Build beside the destination so failed validation preserves its old contents.
# Default musl-runtime inputs also remain alive until they have been copied.
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

if [ "${ARCH}" = "riscv64" ]; then
    if [ "${RISCV64_BUN_ZIP_EXPLICIT}" = "1" ] && [ -s "${RISCV64_BUN_ZIP}" ]; then
        newest_input="$(
            python3 - "${OS_ROOT}/toolchains/bun-riscv64" <<'PY'
from pathlib import Path
import sys

root = Path(sys.argv[1])
paths = [root / "bun-version.json"]
for dirname in ("bun-patches", "webkit-patches"):
    paths.extend(path for path in (root / dirname).glob("**/*") if path.is_file())

print(max((path.stat().st_mtime for path in paths if path.is_file()), default=0))
PY
        )"
        zip_mtime="$(python3 - "${RISCV64_BUN_ZIP}" <<'PY'
from pathlib import Path
import sys
print(Path(sys.argv[1]).stat().st_mtime)
PY
)"
        set +e
        python3 - "${zip_mtime}" "${newest_input}" <<'PY'
import sys
zip_mtime = float(sys.argv[1])
newest_input = float(sys.argv[2] or 0)
if zip_mtime < newest_input:
    raise SystemExit(66)
PY
        rc="$?"
        set -e
        if [ "${rc}" != "0" ]; then
            if [ "${rc}" = "66" ]; then
                echo "ERROR: riscv64 Bun zip predates current patch-series input: ${RISCV64_BUN_ZIP}" >&2
            fi
            exit "${rc}"
        fi
        mkdir -p "${OUT}/elizaos-app/musl-runtime"
        python3 - "${RISCV64_BUN_ZIP}" "${OUT}/elizaos-app/musl-runtime/bun" <<'PY'
from pathlib import Path, PurePosixPath
import shutil
import stat
import sys
import zipfile

zip_path = Path(sys.argv[1])
dest = Path(sys.argv[2])
with zipfile.ZipFile(zip_path) as archive:
    members = [entry for entry in archive.infolist()
               if not entry.is_dir() and PurePosixPath(entry.filename).name == "bun"]
    if len(members) != 1:
        raise SystemExit("ERROR: riscv64 Bun zip must contain exactly one bun file")
    member = members[0]
    kind = stat.S_IFMT(member.external_attr >> 16)
    if kind not in (0, stat.S_IFREG) or member.file_size == 0:
        raise SystemExit("ERROR: riscv64 Bun zip entry must be a nonempty regular file")
    with archive.open(member) as source, dest.open("xb") as target:
        shutil.copyfileobj(source, target, 1024 * 1024)
dest.chmod(dest.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
PY
        if ! bash "${OS_ROOT}/scripts/verify-riscv64-elf.sh" --executable "${OUT}/elizaos-app/musl-runtime/bun"; then
            echo "ERROR: riscv64 Bun zip must contain an ELF64 RISC-V double-float executable" >&2
            exit 65
        fi
        if [ -d "${RISCV64_MUSL_RUNTIME}" ]; then
            find "${RISCV64_MUSL_RUNTIME}" -maxdepth 1 -type f ! -name bun -exec cp -a {} "${OUT}/elizaos-app/musl-runtime/" \;
        fi
        if [ -n "${RISCV64_ICU_DATA}" ] && [ -d "${RISCV64_ICU_DATA}" ]; then
            mkdir -p "${OUT}/elizaos-app/musl-runtime/icu"
            cp -a "${RISCV64_ICU_DATA}/." "${OUT}/elizaos-app/musl-runtime/icu/"
        fi
        ln -s "elizaos-app/musl-runtime/bun" "${OUT}/bun"
        (cd "${OUT}" && sha256sum elizaos-app/musl-runtime/bun > bun.sha256)
        write_riscv64_provenance "${RISCV64_BUN_ZIP}" "${OUT}/elizaos-app/musl-runtime/bun"
        write_manifest "$(file -b "${RISCV64_BUN_ZIP}")" "$(sha256_file "${OUT}/elizaos-app/musl-runtime/bun")"
    elif [ "${RISCV64_BUN_ZIP_EXPLICIT}" = "1" ]; then
        echo "ERROR: missing riscv64 Bun zip: ${RISCV64_BUN_ZIP}" >&2
        exit 65
    else
        write_manifest "node-shebang-agent-bundle-no-bun" ""
    fi
elif [ -n "${BUN_SOURCE}" ]; then
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
