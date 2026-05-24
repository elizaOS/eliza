#!/usr/bin/env bash
# Stage a real elizaOS agent bundle and target Bun runtime for live-build.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
LINUX_DIR="${ROOT}/packages/os/linux/elizaos"
AGENT_DIR="${ROOT}/packages/agent"
BUN_RISCV64_VERSION_JSON="${ROOT}/packages/app-core/scripts/bun-riscv64/bun-version.json"

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
Usage: $0 [--arch amd64|arm64|riscv64] [--bun PATH] [--riscv64-bun-zip PATH] [--riscv64-musl-runtime DIR] [--riscv64-icu-data DIR] [--out DIR] [--skip-build]

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
For riscv64, --riscv64-bun-zip accepts the shared bun-linux-riscv64-musl.zip
artifact and stages its bun binary into elizaos-app/musl-runtime/bun while
installing the Debian wrapper as the top-level bun launcher.
Pass --riscv64-icu-data with Alpine icu-data-full's usr/share/icu/<version>
directory so Bun's Unicode normalization paths can find icudt*.dat.
If riscv64 has no Bun input, the script stages the Node-shebang agent bundle
without /opt/elizaos/bin/bun; the live image must install nodejs.
EOF
}

ARCH="${ELIZAOS_ARCH:-$(arch_from_uname)}"
BUN_SOURCE="${ELIZAOS_BUN_SOURCE:-}"
BUN_RISCV64_ZIP="${ELIZAOS_BUN_RISCV64_FILE:-}"
RISCV64_MUSL_RUNTIME="${ELIZAOS_RISCV64_MUSL_RUNTIME_DIR:-}"
RISCV64_ICU_DATA="${ELIZAOS_RISCV64_ICU_DATA_DIR:-}"
BUN_SOURCE_URL="${ELIZAOS_BUN_SOURCE_URL:-}"
BUN_SOURCE_SHA256="${ELIZAOS_BUN_SOURCE_SHA256:-}"
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
        --riscv64-bun-zip)
            BUN_RISCV64_ZIP="${2:?missing --riscv64-bun-zip value}"
            shift 2
            ;;
        --riscv64-musl-runtime)
            RISCV64_MUSL_RUNTIME="${2:?missing --riscv64-musl-runtime value}"
            shift 2
            ;;
        --riscv64-icu-data)
            RISCV64_ICU_DATA="${2:?missing --riscv64-icu-data value}"
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
OUT_DIR="$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve())' "${OUT_DIR}")"

if [ -n "${BUN_RISCV64_ZIP}" ] && [ "${ARCH}" != "riscv64" ]; then
    echo "ERROR: --riscv64-bun-zip is only valid with --arch riscv64." >&2
    exit 64
fi
if [ -n "${RISCV64_ICU_DATA}" ] && [ "${ARCH}" != "riscv64" ]; then
    echo "ERROR: --riscv64-icu-data is only valid with --arch riscv64." >&2
    exit 64
fi
if [ -n "${RISCV64_ICU_DATA}" ]; then
    if [ ! -d "${RISCV64_ICU_DATA}" ]; then
        echo "ERROR: riscv64 ICU data directory missing: ${RISCV64_ICU_DATA}" >&2
        exit 66
    fi
    if ! find "${RISCV64_ICU_DATA}" -maxdepth 1 -type f -name 'icudt*.dat' | grep -q .; then
        echo "ERROR: riscv64 ICU data directory has no icudt*.dat: ${RISCV64_ICU_DATA}" >&2
        exit 66
    fi
fi

if [ -n "${BUN_RISCV64_ZIP}" ]; then
    if [ ! -f "${BUN_RISCV64_ZIP}" ]; then
        echo "ERROR: riscv64 Bun zip missing: ${BUN_RISCV64_ZIP}" >&2
        exit 66
    fi
    if [ -n "${BUN_SOURCE_SHA256}" ]; then
        actual_zip_sha="$(sha256sum "${BUN_RISCV64_ZIP}" | awk '{print $1}')"
        if [ "${actual_zip_sha}" != "${BUN_SOURCE_SHA256}" ]; then
            echo "ERROR: riscv64 Bun zip SHA-256 mismatch: expected ${BUN_SOURCE_SHA256}, got ${actual_zip_sha}" >&2
            exit 66
        fi
    fi
    if [ -f "${BUN_RISCV64_VERSION_JSON}" ]; then
        stale_input="$(
            find \
                "${BUN_RISCV64_VERSION_JSON}" \
                "${ROOT}/packages/app-core/scripts/bun-riscv64/bun-patches" \
                "${ROOT}/packages/app-core/scripts/bun-riscv64/webkit-patches" \
                -type f \( -name '*.patch' -o -name '*.recipe' -o -name 'bun-version.json' \) \
                -newer "${BUN_RISCV64_ZIP}" \
                -print \
                | head -1
        )"
        if [ -n "${stale_input}" ]; then
            echo "ERROR: riscv64 Bun zip predates current patch-series input: ${stale_input}" >&2
            echo "Rebuild packages/app-core/scripts/bun-riscv64/dist/bun-linux-riscv64-musl.zip before staging." >&2
            exit 66
        fi
    fi
fi

if [ -z "${BUN_SOURCE}" ] && [ "${ARCH}" = "amd64" ]; then
    BUN_SOURCE="$(command -v bun || true)"
fi

if [ -z "${BUN_SOURCE}" ] && [ -z "${BUN_RISCV64_ZIP}" ] && [ "${ARCH}" != "riscv64" ]; then
    echo "ERROR: --bun or ELIZAOS_BUN_SOURCE is required for ${ARCH}." >&2
    exit 66
fi

if [ -n "${BUN_SOURCE}" ] && [ ! -x "${BUN_SOURCE}" ]; then
    echo "ERROR: Bun source is not executable: ${BUN_SOURCE}" >&2
    exit 66
fi

if [ -n "${BUN_SOURCE}" ]; then
    BUN_FILE="$(file -b "${BUN_SOURCE}")"
    case "${ARCH}:${BUN_FILE}" in
        amd64:*x86-64*) ;;
        arm64:*aarch64*|arm64:*ARM\ aarch64*) ;;
        riscv64:*RISC-V*) ;;
        riscv64:*shell\ script*)
            if ! grep -q 'musl-runtime/bun' "${BUN_SOURCE}"; then
                echo "ERROR: riscv64 Bun shell wrapper must exec musl-runtime/bun: ${BUN_SOURCE}" >&2
                exit 66
            fi
            ;;
        *)
            echo "ERROR: Bun source architecture does not match ${ARCH}: ${BUN_FILE}" >&2
            exit 66
            ;;
    esac
elif [ -n "${BUN_RISCV64_ZIP}" ]; then
    BUN_FILE="$(file -b "${BUN_RISCV64_ZIP}")"
elif [ "${ARCH}" = "riscv64" ]; then
    BUN_FILE="node-shebang-agent-bundle-no-bun"
else
    BUN_FILE="bun-linux-riscv64-musl.zip"
fi

if [ "${SKIP_BUILD}" -eq 0 ]; then
    bun run --cwd "${AGENT_DIR}" build:mobile
fi

if [ ! -f "${AGENT_DIR}/dist-mobile/agent-bundle.js" ]; then
    echo "ERROR: missing ${AGENT_DIR}/dist-mobile/agent-bundle.js" >&2
    exit 65
fi
if [ "${ARCH}" = "riscv64" ] && [ -n "${BUN_SOURCE}" ] && grep -q 'musl-runtime/bun' "${BUN_SOURCE}"; then
    if [ ! -x "${AGENT_DIR}/dist-mobile/musl-runtime/bun" ]; then
        echo "ERROR: riscv64 Bun wrapper requires ${AGENT_DIR}/dist-mobile/musl-runtime/bun." >&2
        exit 65
    fi
fi

patch_riscv64_node_bundle() {
    bundle_path="$1"
    python3 - "${bundle_path}" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
import_line = 'import { createRequire as __elizaCreateRequire } from "node:module";\n'
if import_line not in text:
    shebang = "#!/usr/bin/env node\n"
    if text.startswith(shebang):
        text = shebang + import_line + text[len(shebang):]
    else:
        text = import_line + text

old = "var __require = import.meta.require;"
new = (
    "var __require = typeof import.meta.require === \"function\" "
    "? import.meta.require : __elizaCreateRequire(import.meta.url);"
)
if old not in text and new not in text:
    raise SystemExit(f"missing expected Bun require shim in {path}")
text = text.replace(old, new, 1)
path.write_text(text, encoding="utf-8")
PY
}

rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}/elizaos-app"
cp -a "${AGENT_DIR}/dist-mobile/." "${OUT_DIR}/elizaos-app/"
if [ "${ARCH}" = "riscv64" ]; then
    patch_riscv64_node_bundle "${OUT_DIR}/elizaos-app/agent-bundle.js"
fi
if [ -n "${BUN_RISCV64_ZIP}" ]; then
    mkdir -p "${OUT_DIR}/elizaos-app/musl-runtime"
    if [ -n "${RISCV64_MUSL_RUNTIME}" ]; then
        if [ ! -f "${RISCV64_MUSL_RUNTIME}/ld-musl-riscv64.so.1" ]; then
            echo "ERROR: riscv64 musl runtime missing ld-musl-riscv64.so.1: ${RISCV64_MUSL_RUNTIME}" >&2
            exit 66
        fi
        cp -a "${RISCV64_MUSL_RUNTIME}/." "${OUT_DIR}/elizaos-app/musl-runtime/"
    fi
    unzip -p "${BUN_RISCV64_ZIP}" bun-linux-riscv64-musl/bun > "${OUT_DIR}/elizaos-app/musl-runtime/bun"
    chmod 0755 "${OUT_DIR}/elizaos-app/musl-runtime/bun"
    if [ -n "${RISCV64_ICU_DATA}" ]; then
        mkdir -p "${OUT_DIR}/elizaos-app/musl-runtime/icu"
        cp -a "${RISCV64_ICU_DATA}/." "${OUT_DIR}/elizaos-app/musl-runtime/icu/"
    fi
    if [ ! -f "${OUT_DIR}/elizaos-app/musl-runtime/ld-musl-riscv64.so.1" ]; then
        echo "ERROR: riscv64 Bun zip staging requires ld-musl-riscv64.so.1 in dist-mobile/musl-runtime or --riscv64-musl-runtime." >&2
        exit 65
    fi
    for soname in libstdc++.so.6 libicui18n.so.74 libicuuc.so.74 libicudata.so.74; do
        if [ ! -e "${OUT_DIR}/elizaos-app/musl-runtime/${soname}" ]; then
            echo "ERROR: riscv64 Bun runtime missing ${soname}; refresh --riscv64-musl-runtime from Alpine v3.21 sysroot." >&2
            exit 65
        fi
    done
    cat > "${OUT_DIR}/bun" <<'EOF'
#!/bin/sh
if [ -d /opt/elizaos/app/musl-runtime/icu ]; then
    export ICU_DATA=/opt/elizaos/app/musl-runtime/icu
fi
exec /opt/elizaos/app/musl-runtime/ld-musl-riscv64.so.1 \
    --library-path /opt/elizaos/app/musl-runtime \
    /opt/elizaos/app/musl-runtime/bun "$@"
EOF
    chmod 0755 "${OUT_DIR}/bun"
elif [ -n "${BUN_SOURCE}" ]; then
    install -m 0755 "${BUN_SOURCE}" "${OUT_DIR}/bun"
fi
for asset in vector.tar.gz fuzzystrmatch.tar.gz; do
    if [ -f "${AGENT_DIR}/dist-mobile/${asset}" ]; then
        install -m 0644 "${AGENT_DIR}/dist-mobile/${asset}" "${OUT_DIR}/${asset}"
    elif [ -f "${OUT_DIR}/elizaos-app/${asset}" ]; then
        install -m 0644 "${OUT_DIR}/elizaos-app/${asset}" "${OUT_DIR}/${asset}"
    fi
done

(
    cd "${OUT_DIR}"
    if [ -f bun ]; then
        sha256sum bun > bun.sha256
    fi
    find vector.tar.gz fuzzystrmatch.tar.gz -type f -print0 | sort -z | xargs -0 sha256sum > elizaos-root-assets.sha256
)
(
    cd "${OUT_DIR}/elizaos-app"
    find . -type f -print0 | sort -z | xargs -0 sha256sum > "${OUT_DIR}/elizaos-app.sha256"
)

cat > "${OUT_DIR}/manifest.txt" <<EOF
arch=${ARCH}
bun_source=${BUN_SOURCE}
bun_riscv64_zip=${BUN_RISCV64_ZIP}
riscv64_musl_runtime=${RISCV64_MUSL_RUNTIME}
riscv64_icu_data=${RISCV64_ICU_DATA}
bun_source_url=${BUN_SOURCE_URL}
bun_source_sha256=${BUN_SOURCE_SHA256}
bun_staged_sha256=$([ -f "${OUT_DIR}/bun.sha256" ] && cut -d ' ' -f1 "${OUT_DIR}/bun.sha256" || true)
bun_file=${BUN_FILE}
agent_bundle=${AGENT_DIR}/dist-mobile/agent-bundle.js
EOF

if [ "${ARCH}" = "riscv64" ] && { [ -n "${BUN_RISCV64_ZIP}" ] || [ -n "${BUN_SOURCE}" ]; }; then
    export ELIZAOS_STAGE_OUT_DIR="${OUT_DIR}"
    export ELIZAOS_STAGE_BUN_VERSION_JSON="${BUN_RISCV64_VERSION_JSON}"
    export ELIZAOS_STAGE_BUN_ZIP="${BUN_RISCV64_ZIP}"
    export ELIZAOS_STAGE_BUN_SOURCE="${BUN_SOURCE}"
    export ELIZAOS_STAGE_MUSL_RUNTIME="${RISCV64_MUSL_RUNTIME}"
    export ELIZAOS_STAGE_ICU_DATA="${RISCV64_ICU_DATA}"
    export ELIZAOS_STAGE_BUN_SOURCE_URL="${BUN_SOURCE_URL}"
    export ELIZAOS_STAGE_BUN_SOURCE_SHA256="${BUN_SOURCE_SHA256}"
    python3 - <<'PY'
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

out_dir = Path(os.environ["ELIZAOS_STAGE_OUT_DIR"]).resolve()
version_json = Path(os.environ["ELIZAOS_STAGE_BUN_VERSION_JSON"]).resolve()
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


version_data = json.loads(version_json.read_text(encoding="utf-8"))
patch_series = version_data.get("patch_series", {})
patch_inputs: dict[str, str] = {}
for key, folder in (
    ("bun_patches", "bun-patches"),
    ("webkit_patches", "webkit-patches"),
    ("webkit_recipes", "webkit-patches"),
):
    entries = patch_series.get(key, {})
    if not isinstance(entries, dict):
        continue
    for name in sorted(entries):
        path = script_dir / folder / name
        patch_inputs[rel(path)] = sha256_file(path)

zip_path = os.environ.get("ELIZAOS_STAGE_BUN_ZIP", "")
source_path = os.environ.get("ELIZAOS_STAGE_BUN_SOURCE", "")
doc = {
    "schema": "eliza.os.linux.riscv64_bun_stage_provenance.v1",
    "generated_utc": datetime.now(timezone.utc).isoformat(),
    "claim_boundary": (
        "staged riscv64 Bun artifact provenance for Debian/AOSP shared "
        "userland runtime; not a boot or agent-health runtime claim"
    ),
    "producer": "packages/os/linux/elizaos/scripts/stage-agent-artifacts.sh",
    "bun": {
        "tag": version_data.get("bun", {}).get("tag"),
        "channel": version_data.get("bun", {}).get("channel"),
    },
    "webkit": {
        "fork_commit": version_data.get("webkit", {}).get("fork_commit"),
        "jit_tier": version_data.get("webkit", {}).get("jit_tier"),
    },
    "inputs": {
        rel(version_json): sha256_file(version_json),
        **patch_inputs,
    },
    "artifact": {
        "zip_path": zip_path,
        "zip_sha256": sha256_file(Path(zip_path)) if zip_path else "",
        "source_path": source_path,
        "source_sha256": sha256_file(Path(source_path)) if source_path else "",
        "staged_bun": rel(out_dir / "elizaos-app/musl-runtime/bun"),
        "staged_bun_sha256": sha256_file(out_dir / "elizaos-app/musl-runtime/bun"),
        "musl_runtime": os.environ.get("ELIZAOS_STAGE_MUSL_RUNTIME", ""),
        "icu_data": os.environ.get("ELIZAOS_STAGE_ICU_DATA", ""),
        "staged_icu_data": rel(out_dir / "elizaos-app/musl-runtime/icu")
        if (out_dir / "elizaos-app/musl-runtime/icu").exists()
        else "",
        "source_url": os.environ.get("ELIZAOS_STAGE_BUN_SOURCE_URL", ""),
        "source_expected_sha256": os.environ.get("ELIZAOS_STAGE_BUN_SOURCE_SHA256", ""),
    },
}
(out_dir / "riscv64-bun-provenance.json").write_text(
    json.dumps(doc, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
PY
fi

echo "staged elizaOS agent artifacts: ${OUT_DIR}"
