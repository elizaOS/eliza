#!/usr/bin/env sh
set -eu

repo_dir="$(CDPATH=; cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$repo_dir"
if [ -d "$repo_dir/external/oss-cad-suite/bin" ]; then
    PATH="$repo_dir/external/oss-cad-suite/bin:$PATH"
fi

if ! command -v yosys >/dev/null 2>&1; then
    echo "STATUS: BLOCKED synth.yosys - Yosys missing. Use Docker/Nix or install Yosys."
    if [ "${REQUIRE_YOSYS:-0}" = "1" ]; then
        exit 2
    fi
    exit 0
fi

if [ ! -f "$repo_dir/build/boot-rom/e1_secure_boot_rom.hex" ]; then
    "$repo_dir/fw/boot-rom/build.sh"
fi

mkdir -p build/reports build/netlist
yosys -q -l build/reports/e1_soc_yosys.log scripts/yosys_e1_soc.ys
printf '\nELIZA_YOSYS_SYNTHESIS_COMPLETE netlist=build/netlist/e1_chip_synth.v top=e1_chip_top\n' >> build/reports/e1_soc_yosys.log
echo "Yosys report: build/reports/e1_soc_yosys.log"
