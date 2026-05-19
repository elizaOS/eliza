#!/usr/bin/env sh
# Cocotb runner for the BPU regression. Mirrors scripts/run_cocotb.sh but
# pivots the working directory into verify/cocotb/bpu where the BPU cocotb
# Makefile lives. Falls back to STATUS: BLOCKED when no local simulator is
# installed, matching the existing chip-package contract for tool gates.
set -eu

REPO_ROOT="$(CDPATH=; cd -- "$(dirname "$0")/.." && pwd)"
COCOTB_DIR="${COCOTB_DIR:-verify/cocotb/bpu}"
COCOTB_TOP="${COCOTB_TOPLEVEL:-bpu_top_tb}"
COCOTB_MOD="${COCOTB_MODULE:-test_bpu_top}"

if [ -d "$REPO_ROOT/external/oss-cad-suite/bin" ]; then
    PATH="$REPO_ROOT/external/oss-cad-suite/bin:$PATH"
fi

if [ -n "${PYTHON:-}" ]; then
    PYTHON_BIN="$PYTHON"
elif [ -x "$REPO_ROOT/.venv/bin/python" ]; then
    PYTHON_BIN="$REPO_ROOT/.venv/bin/python"
else
    PYTHON_BIN=python3
fi

# Normalise to an absolute path so make does not lose it when we cd into
# the cocotb makefile directory.
case "$PYTHON_BIN" in
    /*) ;;
    */*)
        PYTHON_DIR="$(CDPATH=; cd -- "$(dirname "$PYTHON_BIN")" && pwd)"
        PYTHON_BIN="$PYTHON_DIR/$(basename "$PYTHON_BIN")"
        ;;
    *)
        PYTHON_BIN="$(command -v "$PYTHON_BIN" || echo "$PYTHON_BIN")"
        ;;
esac

if ! "$PYTHON_BIN" -c "import cocotb" >/dev/null 2>&1; then
    if ! python3 -c "import cocotb" >/dev/null 2>&1; then
        cat <<EOF
STATUS: BLOCKED bpu.cocotb - cocotb is not installed in the active Python.
Install cocotb (pip install cocotb) or use the chip-package Nix/Docker shell.
EOF
        if [ "${REQUIRE_COCOTB:-0}" = "1" ]; then
            exit 2
        fi
        exit 0
    fi
    PYTHON_BIN=python3
fi

if ! command -v verilator >/dev/null 2>&1 && ! command -v iverilog >/dev/null 2>&1; then
    cat <<EOF
STATUS: BLOCKED bpu.cocotb - No local RTL simulator. Install Verilator or
Icarus Verilog, or use the chip-package Nix/Docker shell.
EOF
    mkdir -p "$REPO_ROOT/build/reports/bpu"
    cat >"$REPO_ROOT/build/reports/bpu/cocotb-status-${COCOTB_MOD}.yaml" <<EOF
schema: eliza.bpu_cocotb_status.v1
module: ${COCOTB_MOD}
toplevel: ${COCOTB_TOP}
status: BLOCKED
reason: "no local Verilator or Icarus Verilog"
remediation: "install Verilator or Icarus Verilog; re-run make cocotb-bpu"
EOF
    if [ "${REQUIRE_BPU_COCOTB:-0}" = "1" ]; then
        exit 2
    fi
    exit 0
fi

SIM_BUILD="$REPO_ROOT/build/cocotb/bpu/${COCOTB_TOP}_${COCOTB_MOD}"
RESULT_DIR="$REPO_ROOT/verify/cocotb/bpu/results"
REPORT_DIR="$REPO_ROOT/build/reports/cocotb/bpu"
RESULT_FILE="$RESULT_DIR/${COCOTB_TOP}_${COCOTB_MOD}.xml"
RAW_RESULT="$REPORT_DIR/${COCOTB_TOP}_${COCOTB_MOD}.raw.xml"
mkdir -p "$SIM_BUILD" "$RESULT_DIR" "$REPORT_DIR"
rm -rf "$SIM_BUILD"
mkdir -p "$SIM_BUILD"

if command -v verilator >/dev/null 2>&1; then
    SIM_NAME=verilator
else
    SIM_NAME=icarus
fi

# Force the cocotb sub-make to resolve everything against the venv copy of
# cocotb (PYTHONPATH) and the oss-cad-suite copy of verilator (PATH). Some
# cocotb installs ship cocotb-config as a setuptools entry point that is not
# always on PATH; create a shim so the cocotb sub-make can find it.
PYTHON_DIR="$(dirname "$PYTHON_BIN")"
SITE_PACKAGES="$("$PYTHON_BIN" -c 'import site; print(":".join(site.getsitepackages()))' 2>/dev/null || true)"
if [ -n "$SITE_PACKAGES" ]; then
    PYTHONPATH="$SITE_PACKAGES${PYTHONPATH:+:$PYTHONPATH}"
    export PYTHONPATH
fi
PATH="$PYTHON_DIR:$PATH"
# Always materialise a cocotb-config shim under build/. A venv may carry a
# cocotb-config from another host whose shebang points at /work/.venv/bin/python
# or similar; the shim guarantees the cocotb sub-make can resolve it.
SHIM_DIR="$REPO_ROOT/build/cocotb/bpu/bin"
mkdir -p "$SHIM_DIR"
cat >"$SHIM_DIR/cocotb-config" <<EOF
#!/usr/bin/env sh
exec "$PYTHON_BIN" -m cocotb.config "\$@"
EOF
chmod +x "$SHIM_DIR/cocotb-config"
PATH="$SHIM_DIR:$PATH"
export PATH

cd "$REPO_ROOT/$COCOTB_DIR"

make SIM="$SIM_NAME" \
    MODULE="$COCOTB_MOD" \
    TOPLEVEL="$COCOTB_TOP" \
    PYTHON="$PYTHON_BIN" \
    SIM_BUILD="$SIM_BUILD"

if [ -f "$REPO_ROOT/$COCOTB_DIR/results.xml" ]; then
    cp "$REPO_ROOT/$COCOTB_DIR/results.xml" "$RESULT_FILE"
    cp "$REPO_ROOT/$COCOTB_DIR/results.xml" "$RAW_RESULT"
    "$PYTHON_BIN" "$REPO_ROOT/scripts/check_cocotb_results.py" \
        --result "$RAW_RESULT" \
        --module "$COCOTB_MOD" \
        --top "$COCOTB_TOP"
fi
