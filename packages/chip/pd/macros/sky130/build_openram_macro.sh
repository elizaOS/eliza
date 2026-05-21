#!/usr/bin/env bash
# Native OpenRAM macro build driver for the e1 Sky130 hard-macro inventory.
#
# Generates LEF/GDS/Liberty/SPICE for one e1 SRAM macro from its
# <name>.openram.config.py using the locally checked-out OpenRAM tree
# (external/OpenRAM, v1.2.49) against the Volare sky130A PDK pinned in
# pd/macros/manifest.yaml. Runs natively on Linux x64 — no Docker.
#
# OpenRAM is invoked through its sram_compiler.py entry point, which bootstraps
# the "openram" package from $OPENRAM_HOME/../__init__.py (the checkout dir is
# named OpenRAM, not openram, so a plain `import openram` does not resolve).
#
# The EDA stack OpenRAM shells out to (magic/ngspice/netgen) comes from the
# openram-miniconda environment at $OPENRAM_CONDA. That Magic (8.3.363) cannot
# load Volare's sky130A techfile, so inline DRC/LVS is disabled in the configs
# and DRC is verified afterwards with the newer native Magic 8.3.645 via
# scripts/check_openram_macro_drc.py.
#
# Usage:
#   pd/macros/sky130/build_openram_macro.sh <macro_dir> [config_file]
#
# Example:
#   pd/macros/sky130/build_openram_macro.sh \
#       pd/macros/sky130/e1_sram_4kb_1rw
#
# The config defaults to <macro_dir>/<basename>.openram.config.py. Outputs land
# in the output_path declared by the config (conventionally <macro_dir>/build).
set -euo pipefail

REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
cd "$REPO_ROOT"

MACRO_DIR=${1:?usage: build_openram_macro.sh <macro_dir> [config_file]}
MACRO_NAME=$(basename "$MACRO_DIR")
CONFIG=${2:-"$MACRO_DIR/$MACRO_NAME.openram.config.py"}

if [ ! -f "$CONFIG" ]; then
    echo "ERROR: config not found: $CONFIG" >&2
    exit 2
fi

# Pinned, present Volare sky130A snapshot (matches pd/macros/manifest.yaml and
# pd/openlane/config.sky130.json). OpenRAM's sky130 technology __init__.py reads
# $PDK_ROOT/sky130A/libs.tech for the magicrc + tech files.
PDK_VERSION=c6d73a35f524070e85faff4a6a9eef49553ebc2b
export PDK_ROOT="$REPO_ROOT/external/pdks/volare/sky130/versions/$PDK_VERSION"
if [ ! -d "$PDK_ROOT/sky130A/libs.tech" ]; then
    echo "ERROR: Volare sky130A PDK not found at $PDK_ROOT" >&2
    echo "Fetch it with:" >&2
    echo "  volare enable --pdk sky130 $PDK_VERSION" >&2
    echo "(set PDK_ROOT=$REPO_ROOT/external/pdks/volare before running volare)" >&2
    exit 3
fi

export OPENRAM_HOME="$REPO_ROOT/external/OpenRAM/compiler"
export OPENRAM_TECH="$REPO_ROOT/external/OpenRAM/technology"
if [ ! -d "$OPENRAM_HOME" ]; then
    echo "ERROR: OpenRAM not checked out at $REPO_ROOT/external/OpenRAM" >&2
    echo "Clone it with:" >&2
    echo "  git clone https://github.com/VLSIDA/OpenRAM external/OpenRAM" >&2
    exit 3
fi

# openram-miniconda supplies python3.8 + magic + ngspice + netgen + klayout that
# OpenRAM expects on PATH. Override with OPENRAM_CONDA if installed elsewhere.
OPENRAM_CONDA=${OPENRAM_CONDA:-"$HOME/.openram-miniconda"}
if [ ! -x "$OPENRAM_CONDA/bin/python3" ]; then
    echo "ERROR: openram-miniconda python not found at $OPENRAM_CONDA/bin/python3" >&2
    echo "Install per external/OpenRAM/docs (the conda EDA stack: magic/ngspice/netgen/klayout)." >&2
    exit 3
fi
export PATH="$OPENRAM_CONDA/bin:$PATH"
PY="$OPENRAM_CONDA/bin/python3"

# OpenRAM imports the config as a Python module, so the basename (minus .py)
# must be a valid identifier (globals.py read_config -> isidentifier check).
# The canonical config name <macro_dir>/<name>.openram.config.py contains dots
# and is therefore rejected. Copy it to a valid-identifier name inside build/
# and feed OpenRAM that copy; the canonical dotted file remains the tracked
# source of record (referenced by scripts/ai_eda/capture_*).
BUILD_DIR="$MACRO_DIR/build"
mkdir -p "$BUILD_DIR"
RUN_CONFIG="$BUILD_DIR/openram_config.py"
cp "$CONFIG" "$RUN_CONFIG"

echo "[build_openram_macro] macro_dir=$MACRO_DIR"
echo "[build_openram_macro] config=$CONFIG"
echo "[build_openram_macro] run_config=$RUN_CONFIG"
echo "[build_openram_macro] PDK_ROOT=$PDK_ROOT"
echo "[build_openram_macro] OPENRAM_HOME=$OPENRAM_HOME"
echo "[build_openram_macro] python=$($PY --version 2>&1)"

exec "$PY" "$REPO_ROOT/external/OpenRAM/sram_compiler.py" "$RUN_CONFIG"
