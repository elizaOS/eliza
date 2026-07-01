#!/usr/bin/env sh
set -eu

REPO_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$REPO_DIR"

MANIFEST="${CHIPYARD_MANIFEST:-docs/generators/chipyard/eliza-rocket-manifest.json}"
CHECKOUT="${CHIPYARD_CHECKOUT:-external/chipyard}"
PREFLIGHT_REPORT="${CHIPYARD_PREFLIGHT_REPORT:-build/chipyard/eliza_rocket/bootstrap-preflight.json}"
SUBMODULE_JOBS="${CHIPYARD_SUBMODULE_JOBS:-1}"
SUBMODULE_RETRIES="${CHIPYARD_SUBMODULE_RETRIES:-3}"
RUN_SETUP="${CHIPYARD_RUN_SETUP:-0}"
GENERATE_VERILOG="${CHIPYARD_GENERATE_VERILOG:-0}"

case "$CHECKOUT" in
    /*) CHECKOUT_ABS="$CHECKOUT" ;;
    *) CHECKOUT_ABS="$REPO_DIR/$CHECKOUT" ;;
esac

if [ "$RUN_SETUP" = "1" ]; then
    case "$(uname -s)" in
        Linux) ;;
        *)
            echo "bootstrap_chipyard: CHIPYARD_RUN_SETUP=1 is supported only on Linux hosts; use the documented Chipyard container path on this host." >&2
            exit 1
            ;;
    esac
fi

CHIPYARD_REPO="${CHIPYARD_REPO:-$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["chipyard"]["repo"])' "$MANIFEST")}"
CHIPYARD_TAG="${CHIPYARD_TAG:-$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["chipyard"]["tag"])' "$MANIFEST")}"
CHIPYARD_SHA="${CHIPYARD_SHA:-$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["chipyard"]["commit"])' "$MANIFEST")}"

if [ -z "$CHIPYARD_SHA" ]; then
    echo "bootstrap_chipyard: CHIPYARD_SHA must be set." >&2
    exit 2
fi

mkdir -p external
if [ ! -d "$CHECKOUT" ]; then
    git clone "$CHIPYARD_REPO" "$CHECKOUT"
fi

cd "$CHECKOUT"
git fetch --tags origin
tag_sha="$(git rev-list -n 1 "$CHIPYARD_TAG")"
if [ "$tag_sha" != "$CHIPYARD_SHA" ]; then
    echo "bootstrap_chipyard: tag $CHIPYARD_TAG resolves to $tag_sha, expected $CHIPYARD_SHA" >&2
    exit 1
fi
git checkout --detach "$CHIPYARD_SHA"

cleanup_broken_submodule() {
    path=$1
    if [ ! -d "$path" ]; then
        return 0
    fi
    if git -C "$path" rev-parse --verify HEAD >/dev/null 2>&1; then
        return 0
    fi
    echo "bootstrap_chipyard: removing interrupted submodule checkout: $path" >&2
    git submodule deinit -f "$path" >/dev/null 2>&1 || true
    rm -rf "$path" ".git/modules/$path"
}

submodule_update_retry() {
    attempt=1
    while [ "$attempt" -le "$SUBMODULE_RETRIES" ]; do
        git submodule sync --recursive
        if git submodule update --init --recursive --jobs "$SUBMODULE_JOBS" "$@"; then
            return 0
        fi
        cleanup_broken_submodule "generators/rocket-chip/dependencies/chisel"
        cleanup_broken_submodule "generators/rocket-chip/dependencies/diplomacy"
        cleanup_broken_submodule "generators/rocket-chip/dependencies/hardfloat"
        echo "bootstrap_chipyard: submodule update failed; retry $attempt/$SUBMODULE_RETRIES" >&2
        attempt=$((attempt + 1))
        sleep "$attempt"
    done
    git submodule update --init --recursive --jobs "$SUBMODULE_JOBS" "$@"
}

submodule_update_top_retry() {
    attempt=1
    while [ "$attempt" -le "$SUBMODULE_RETRIES" ]; do
        git submodule sync -- "$@"
        if git submodule update --init --jobs "$SUBMODULE_JOBS" "$@"; then
            return 0
        fi
        echo "bootstrap_chipyard: top-level submodule update failed; retry $attempt/$SUBMODULE_RETRIES" >&2
        attempt=$((attempt + 1))
        sleep "$attempt"
    done
    git submodule update --init --jobs "$SUBMODULE_JOBS" "$@"
}

submodule_update_retry generators/rocket-chip
submodule_update_top_retry \
    tools/cde \
    tools/DRAMSim2 \
    tools/dsptools \
    tools/fixedpoint \
    tools/firrtl2 \
    tools/install-circt \
    tools/rocket-dsp-utils \
    generators \
    generators/bar-fetchers \
    generators/ara \
    generators/cva6 \
    generators/ibex \
    generators/nvdla \
    generators/rocc-acc-utils \
    sims/firesim \
    sims/verilator \
    software/firemarshal \
    toolchains/riscv-tools/riscv-isa-sim \
    tools/torture

resolved="$(git rev-parse HEAD)"
if [ "$resolved" != "$CHIPYARD_SHA" ]; then
    echo "bootstrap_chipyard: resolved HEAD ($resolved) != pinned SHA ($CHIPYARD_SHA)" >&2
    exit 1
fi

cd "$REPO_DIR"
python3 - "$MANIFEST" "$CHECKOUT" <<'PY'
import json
import shutil
import sys
from pathlib import Path

manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
checkout = Path(sys.argv[2])
for entry in manifest["selected_path"].get("config_sources", []):
    source = Path(entry["source"])
    destination = checkout / entry["checkout_destination"]
    if not source.is_file():
        raise SystemExit(f"bootstrap_chipyard: missing config source overlay: {source}")
    if destination.exists() and destination.read_bytes() != source.read_bytes():
        raise SystemExit(
            "bootstrap_chipyard: refusing to overwrite different checkout overlay "
            f"{destination}; inspect it or remove it before rerunning"
        )
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    print(f"Installed Chipyard config overlay: {source} -> {destination}")
PY

python3 scripts/check_chipyard_import_preflight.py \
    --checkout "$CHECKOUT" \
    --write-report "$PREFLIGHT_REPORT" \
    --require-checkout

if [ "$RUN_SETUP" = "1" ]; then
    if [ ! -x "$CHECKOUT/build-setup.sh" ]; then
        echo "bootstrap_chipyard: missing executable $CHECKOUT/build-setup.sh after checkout." >&2
        exit 1
    fi
    (
        cd "$CHECKOUT"
        ./build-setup.sh
    )
fi

if [ "$GENERATE_VERILOG" = "1" ]; then
    if [ "$RUN_SETUP" != "1" ] && [ ! -f "$CHECKOUT/env.sh" ]; then
        echo "bootstrap_chipyard: CHIPYARD_GENERATE_VERILOG=1 requires $CHECKOUT/env.sh; rerun with CHIPYARD_RUN_SETUP=1 on Linux." >&2
        exit 1
    fi
    CHIPYARD_CHECKOUT="$CHECKOUT_ABS" scripts/run_chipyard_eliza_verilator.sh verilog
fi

echo "Chipyard $CHIPYARD_TAG checked out under $CHECKOUT at $CHIPYARD_SHA."
if [ "$RUN_SETUP" = "1" ] && [ "$GENERATE_VERILOG" = "1" ]; then
    echo "Requested Chipyard setup and ElizaRocketConfig Verilog generation completed."
else
    echo "Checkout/bootstrap complete. Set CHIPYARD_RUN_SETUP=1 CHIPYARD_GENERATE_VERILOG=1 on Linux to run setup and generation."
fi
