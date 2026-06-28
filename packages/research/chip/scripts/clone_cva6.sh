#!/bin/bash
# Clone CVA6 and set up the include path for e1 chip integration
# Usage: ./scripts/clone_cva6.sh
set -e
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CVA6_DIR="$REPO_ROOT/external/cva6"
CVA6_COMMIT="v5.0.0"  # pinned tag

echo "=== CVA6 Integration Setup ==="

if [ -d "$CVA6_DIR/.git" ]; then
    echo "CVA6 already cloned at $CVA6_DIR"
    echo "Commit: $(git -C "$CVA6_DIR" rev-parse HEAD)"
else
    echo "Cloning CVA6 $CVA6_COMMIT (this may take several minutes)..."
    git clone --depth=1 --branch "$CVA6_COMMIT" \
        https://github.com/openhwgroup/cva6.git "$CVA6_DIR"
    echo "CVA6 cloned."
fi

# Verify key files exist
for f in core/cva6.sv include/ariane_pkg.sv include/riscv_pkg.sv; do
    if [ ! -f "$CVA6_DIR/$f" ]; then
        echo "ERROR: Expected file missing: $CVA6_DIR/$f"
        exit 1
    fi
done

echo ""
echo "CVA6 ready. To build e1 chip with CVA6:"
echo "  Verilator: verilator +define+E1_HAVE_CVA6 \\"
echo "    -I$CVA6_DIR/include -I$CVA6_DIR/core \\"
echo "    rtl/**/*.sv $CVA6_DIR/core/cva6.sv ..."
echo ""
echo "  Yosys (FPGA): yosys -D E1_HAVE_CVA6 \\"
echo "    -p 'read_verilog -sv -I$CVA6_DIR/include $CVA6_DIR/core/cva6.sv rtl/**/*.sv'"

# Write integration marker
echo "$CVA6_COMMIT" > "$REPO_ROOT/external/.cva6_version"
echo "Wrote version marker to external/.cva6_version"
