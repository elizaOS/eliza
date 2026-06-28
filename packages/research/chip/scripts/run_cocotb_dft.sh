#!/usr/bin/env sh
# Cocotb runner for the DFT JTAG TAP test. Mirrors scripts/run_cocotb_bpu.sh
# but pivots into verify/cocotb/dft where the DFT cocotb Makefile lives.
# Falls back to STATUS: BLOCKED when no local simulator is installed, matching
# the chip-package contract for tool gates.
set -eu

REPO_ROOT="$(CDPATH=; cd -- "$(dirname "$0")/.." && pwd)"
COCOTB_DIR="${COCOTB_DIR:-verify/cocotb/dft}"
COCOTB_TOP="${COCOTB_TOPLEVEL:-e1_jtag_tap}"
COCOTB_MOD="${COCOTB_MODULE:-test_e1_jtag_tap}"

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
STATUS: BLOCKED dft.cocotb - cocotb is not installed in the active Python.
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
STATUS: BLOCKED dft.cocotb - No local RTL simulator. Install Verilator or
Icarus Verilog, or use the chip-package Nix/Docker shell.
EOF
    mkdir -p "$REPO_ROOT/build/reports/dft"
    cat >"$REPO_ROOT/build/reports/dft/cocotb-status-${COCOTB_MOD}.yaml" <<EOF
schema: eliza.dft_cocotb_status.v1
module: ${COCOTB_MOD}
toplevel: ${COCOTB_TOP}
status: BLOCKED
reason: "no local Verilator or Icarus Verilog"
remediation: "install Verilator or Icarus Verilog; re-run make jtag-tap-cocotb"
EOF
    if [ "${REQUIRE_DFT_COCOTB:-0}" = "1" ]; then
        exit 2
    fi
    exit 0
fi

SIM_BUILD="$REPO_ROOT/build/cocotb/dft/${COCOTB_TOP}_${COCOTB_MOD}"
RESULT_DIR="$REPO_ROOT/verify/cocotb/dft/results"
REPORT_DIR="$REPO_ROOT/build/reports/cocotb/dft"
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

# Force the cocotb sub-make to resolve cocotb (PYTHONPATH) and verilator
# (PATH); materialise a cocotb-config shim so the sub-make can always find it.
PYTHON_DIR="$(dirname "$PYTHON_BIN")"
SITE_PACKAGES="$("$PYTHON_BIN" -c 'import site; print(":".join(site.getsitepackages()))' 2>/dev/null || true)"
if [ -n "$SITE_PACKAGES" ]; then
    PYTHONPATH="$SITE_PACKAGES${PYTHONPATH:+:$PYTHONPATH}"
    export PYTHONPATH
fi
PATH="$PYTHON_DIR:$PATH"
SHIM_DIR="$REPO_ROOT/build/cocotb/dft/bin"
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
