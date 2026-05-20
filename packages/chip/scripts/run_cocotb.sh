#!/usr/bin/env sh
set -eu

if ! command -v make >/dev/null 2>&1; then
    echo "make is required for cocotb"
    exit 1
fi

REPO_ROOT="$(CDPATH=; cd -- "$(dirname "$0")/.." && pwd)"
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
case "$PYTHON_BIN" in
    */*)
        PYTHON_DIRNAME="$(dirname "$PYTHON_BIN")"
        if [ -d "$PYTHON_DIRNAME" ]; then
            PYTHON_BIN="$(CDPATH=; cd -- "$PYTHON_DIRNAME" && pwd)/$(basename "$PYTHON_BIN")"
        fi
        ;;
esac
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
    PYTHON_BIN=python3
fi
PYTHON_DIR="$(CDPATH=; cd -- "$(dirname "$PYTHON_BIN")" && pwd)"
if [ -x "$PYTHON_DIR/cocotb-config" ] && "$PYTHON_DIR/cocotb-config" --version >/dev/null 2>&1; then
    PATH="$PYTHON_DIR:$PATH"
else
    COCOTB_BIN_DIR="$REPO_ROOT/build/cocotb/bin"
    mkdir -p "$COCOTB_BIN_DIR"
    cat >"$COCOTB_BIN_DIR/cocotb-config" <<EOF
#!/usr/bin/env sh
exec "$PYTHON_BIN" -m cocotb.config "\$@"
EOF
    chmod +x "$COCOTB_BIN_DIR/cocotb-config"
    PATH="$COCOTB_BIN_DIR:$PATH"
fi
PYTHON_SITE="$("$PYTHON_BIN" - <<'PY'
import site
paths = []
for value in site.getsitepackages():
    if value:
        paths.append(value)
user = site.getusersitepackages()
if user:
    paths.append(user)
print(":".join(dict.fromkeys(paths)))
PY
)"
PYTHONPATH="$PYTHON_SITE${PYTHONPATH:+:$PYTHONPATH}"
export PATH PYTHONPATH
PYTHON_PREFIX="$(CDPATH=; cd -- "$PYTHON_DIR/.." && pwd)"
if [ -d "$PYTHON_PREFIX/lib" ]; then
    DYLD_LIBRARY_PATH="$PYTHON_PREFIX/lib${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
    LD_LIBRARY_PATH="$PYTHON_PREFIX/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    export DYLD_LIBRARY_PATH LD_LIBRARY_PATH
fi

if ! "$PYTHON_BIN" -c "import cocotb" >/dev/null 2>&1; then
    if ! python3 -c "import cocotb" >/dev/null 2>&1; then
        echo "cocotb is not installed. Use Docker/Nix or install cocotb in a virtualenv."
        exit 1
    fi
fi

COCOTB_TOP="${COCOTB_TOPLEVEL:-e1_chip_top}"
COCOTB_MOD="${COCOTB_MODULE:-test_e1_chip}"
COCOTB_DIR="${COCOTB_DIR:-verify/cocotb}"
COCOTB_BUILD="$REPO_ROOT/build/cocotb/${COCOTB_TOP}_${COCOTB_MOD}"
COCOTB_LOCK="$REPO_ROOT/build/cocotb/.${COCOTB_TOP}_${COCOTB_MOD}.lock"
COCOTB_RESULTS_LOCK="$REPO_ROOT/build/cocotb/.results.lock"
COCOTB_RESULT_DIR="$REPO_ROOT/verify/cocotb/results"
COCOTB_RESULT_FILE="$COCOTB_RESULT_DIR/${COCOTB_TOP}_${COCOTB_MOD}.xml"
COCOTB_REPORT_DIR="$REPO_ROOT/build/reports/cocotb"
COCOTB_RAW_RESULT="$COCOTB_REPORT_DIR/${COCOTB_TOP}_${COCOTB_MOD}.raw.xml"
mkdir -p "$REPO_ROOT/build/cocotb"
mkdir -p "$COCOTB_RESULT_DIR"
mkdir -p "$COCOTB_REPORT_DIR"

if [ "$COCOTB_TOP" = "e1_chip_top" ] && [ "$COCOTB_MOD" = "test_e1_chip" ]; then
    rm -f "$COCOTB_REPORT_DIR/manifest.json"
    rm -f "$COCOTB_REPORT_DIR"/*.xml "$COCOTB_RESULT_DIR"/*.xml 2>/dev/null || true
fi

while ! mkdir "$COCOTB_LOCK" 2>/dev/null; do
    sleep 1
done
while ! mkdir "$COCOTB_RESULTS_LOCK" 2>/dev/null; do
    sleep 1
done
trap 'rmdir "$COCOTB_RESULTS_LOCK" "$COCOTB_LOCK" 2>/dev/null || true' EXIT INT TERM

rm -rf "$COCOTB_BUILD" "$COCOTB_DIR/results.xml" "$COCOTB_RESULT_FILE" "$COCOTB_RAW_RESULT"

MAKE_FILE_ARG=""
if [ -n "${COCOTB_MAKEFILE:-}" ]; then
    MAKE_FILE_ARG="-f ${COCOTB_MAKEFILE}"
fi

if command -v verilator >/dev/null 2>&1; then
    $(command -v make) -C "$COCOTB_DIR" $MAKE_FILE_ARG SIM=verilator \
        MODULE="$COCOTB_MOD" \
        TOPLEVEL="$COCOTB_TOP" \
        PYTHON="$PYTHON_BIN" \
        SIM_BUILD="$COCOTB_BUILD"
elif command -v iverilog >/dev/null 2>&1; then
    $(command -v make) -C "$COCOTB_DIR" $MAKE_FILE_ARG SIM=icarus \
        MODULE="$COCOTB_MOD" \
        TOPLEVEL="$COCOTB_TOP" \
        PYTHON="$PYTHON_BIN" \
        SIM_BUILD="$COCOTB_BUILD"
else
    echo "No cocotb simulator found. Install Verilator or Icarus Verilog."
    exit 1
fi

cp "$COCOTB_DIR/results.xml" "$COCOTB_RESULT_FILE"
cp "$COCOTB_DIR/results.xml" "$COCOTB_RAW_RESULT"
"$PYTHON_BIN" scripts/check_cocotb_results.py \
    --result "$COCOTB_RAW_RESULT" \
    --module "$COCOTB_MOD" \
    --top "$COCOTB_TOP"
