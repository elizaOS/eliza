#!/usr/bin/env bash
# Elaboration smoke over the committed e1_chip_top OpenLane PD configs.
#
# Each PD config whose DESIGN_NAME is e1_chip_top must list every RTL module
# the synthesizable hierarchy instantiates, or OpenLane synthesis cannot
# elaborate it. This smoke reads each config's VERILOG_FILES + VERILOG_DEFINES
# and runs Verilator --lint-only with the config's own define set (stub-CPU
# path; the real-CVA6 elaboration is proved separately by
# scripts/check_pd_cva6_elaboration.sh). It is the cheap guard behind the
# config-json-broken-verilog-files-missing-cva6-modules finding.
#
# Usage:  scripts/check_pd_config_elaboration.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"
if [ -d "$REPO_DIR/external/oss-cad-suite/bin" ]; then
    PATH="$REPO_DIR/external/oss-cad-suite/bin:$PATH"
fi

if ! command -v verilator >/dev/null 2>&1; then
    echo "FAIL_CLOSED: verilator not on PATH; source tools/env.sh" >&2
    exit 3
fi

CONFIGS="
pd/openlane/config.json
pd/openlane/config.sky130.json
pd/openlane/config.sky130.exploratory.json
pd/openlane/config.gf180.json
pd/openlane/config.gf180.exploratory.json
pd/openlane/config.ihp-sg13g2.json
"

# UNDRIVEN is waived because the hard-SRAM macro is an external blackbox whose
# data outputs are driven by the placed macro, not by RTL.
WAIVERS="-Wno-DECLFILENAME -Wno-UNUSEDSIGNAL -Wno-UNUSEDPARAM -Wno-WIDTHEXPAND \
-Wno-WIDTHTRUNC -Wno-VARHIDDEN -Wno-CASEINCOMPLETE -Wno-UNOPTFLAT \
-Wno-IMPLICITSTATIC -Wno-PINMISSING -Wno-UNDRIVEN"

rc=0
for cfg in $CONFIGS; do
    [ -f "$cfg" ] || { echo "MISSING config: $cfg" >&2; rc=1; continue; }
    cfg_dir="$(dirname "$cfg")"

    # Resolve VERILOG_FILES (dir::-relative to the config dir) + VERILOG_DEFINES.
    mapfile -t files < <(python3 - "$cfg" "$cfg_dir" <<'PY'
import json, sys, os
cfg, cfg_dir = sys.argv[1], sys.argv[2]
d = json.load(open(cfg))
for f in d.get("VERILOG_FILES", []):
    rel = f.replace("dir::", "")
    print(os.path.normpath(os.path.join(cfg_dir, rel)))
PY
)
    defines="$(python3 -c "
import json,sys
d=json.load(open('$cfg'))
print(' '.join('+define+'+x for x in (d.get('VERILOG_DEFINES') or [])))
")"

    # When the config selects the hard SRAM macro, supply the committed
    # blackbox declaration so the (externally placed) macro resolves for
    # elaboration the same way OpenLane supplies it via LEF/lib at synthesis.
    extra_files=()
    if printf '%s' "$defines" | grep -q "E1_HAVE_HARD_SRAM"; then
        extra_files+=("$REPO_DIR/pd/openlane/sky130_sram_2kbyte_1rw1r_32x512_8.blackbox.v")
    fi

    echo "== elaborating $cfg (defines: ${defines:-none}) ==" >&2
    # shellcheck disable=SC2086
    if verilator --lint-only -Wall $WAIVERS $defines "${files[@]}" "${extra_files[@]}" \
        --top-module e1_chip_top >/dev/null 2>"$cfg.elab.log"; then
        echo "PASS: $cfg" >&2
        rm -f "$cfg.elab.log"
    else
        echo "FAIL: $cfg — see $cfg.elab.log" >&2
        tail -20 "$cfg.elab.log" >&2 || true
        rc=1
    fi
done

if [ "$rc" -eq 0 ]; then
    echo "PASS: all e1_chip_top PD configs elaborate." >&2
fi
exit "$rc"
