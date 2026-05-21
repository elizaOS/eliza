#!/usr/bin/env sh
# Run the bound CDC/RDC property packs (cdc_properties.sv / reset_properties.sv)
# against the real power-domain crossing and reset synchroniser via SymbiYosys,
# and emit eliza.cdc_formal_evidence.v1.
#
# Fail-closed contract:
#   * SymbiYosys (sby) is REQUIRED. There is no Yosys fallback for CDC/RDC; a
#     structural fallback would not exercise the bound multiclock properties, so
#     this script refuses to fabricate evidence and exits non-zero when sby is
#     missing.
#   * Each task's .sby must exist; a missing .sby is a hard failure.
#   * Claim boundary stays intent_manifest_only_not_cdc_rdc_signoff. These are
#     bounded BMC anchors on the synchroniser invariants, not CDC/RDC signoff.
set -eu

repo_dir="$(CDPATH=; cd -- "$(dirname -- "$0")/.." && pwd)"
if [ -d "$repo_dir/external/oss-cad-suite/bin" ]; then
    PATH="$repo_dir/external/oss-cad-suite/bin:$PATH"
fi
cd "$repo_dir"

props_dir="verify/properties"
work_dir="build/formal/cdc"
manifest="build/reports/cdc_formal_manifest.json"
mkdir -p "$work_dir" "build/reports"

# task_name : sby_file : bound_module : property_pack : needs_sv_pkg
#   needs_sv_pkg=1 marks a task whose RTL imports a SystemVerilog package in the
#   module header (`module m import pkg::*; #(...)`). The bundled yosys Verilog
#   frontend cannot parse that construct; such tasks require an sv2v lowering
#   pass and are blocked-closed (not failed) when sv2v is absent.
tasks="droop_cdc:droop_cdc.sby:droop_sensor:cdc_properties.sv:1 reset_sync:reset_sync.sby:e1_reset_sync:reset_properties.sv:0"

have_sv2v=0
if command -v sv2v >/dev/null 2>&1; then
    have_sv2v=1
fi

if ! command -v sby >/dev/null 2>&1; then
    echo "BLOCKED: SymbiYosys (sby) missing; CDC/RDC bound-property formal cannot run."
    echo "Install oss-cad-suite or add sby to PATH. No Yosys fallback is offered for CDC/RDC."
    SBY_MISSING=1 MANIFEST="$manifest" TASKS="$tasks" python3 - <<'PY'
import json, os
from pathlib import Path
manifest = Path(os.environ["MANIFEST"])
tasks = {}
for spec in os.environ["TASKS"].split():
    name, sby, mod, pack = spec.split(":")
    tasks[name] = {
        "status": "blocked_requires_sby",
        "sby": f"verify/properties/{sby}",
        "bound_module": mod,
        "property_pack": f"verify/properties/{pack}",
        "claim_boundary": "intent_manifest_only_not_cdc_rdc_signoff",
    }
manifest.write_text(json.dumps({
    "schema": "eliza.cdc_formal_evidence.v1",
    "claim_boundary": "intent_manifest_only_not_cdc_rdc_signoff",
    "status": "blocked",
    "blocked_reason": "SymbiYosys missing; install sby to produce bound-property evidence",
    "tasks": tasks,
}, indent=2, sort_keys=True) + "\n")
print(f"CDC formal manifest (blocked): {manifest}")
PY
    exit 2
fi

fail=0
status_lines=""
for spec in $tasks; do
    name="${spec%%:*}"
    rest="${spec#*:}"
    sby_file="${rest%%:*}"
    rest="${rest#*:}"
    bound_module="${rest%%:*}"
    rest="${rest#*:}"
    property_pack="${rest%%:*}"
    needs_sv_pkg="${rest#*:}"

    spec_path="$props_dir/$sby_file"
    if [ ! -f "$spec_path" ]; then
        echo "FAIL: missing sby spec $spec_path"
        fail=1
        status_lines="$status_lines $name:missing_sby:$sby_file:$bound_module:$property_pack"
        continue
    fi

    if [ "$needs_sv_pkg" = "1" ] && [ "$have_sv2v" = "0" ]; then
        echo "BLOCKED: $name requires sv2v to lower the package-import module header;"
        echo "  the bundled yosys Verilog frontend cannot parse 'module $bound_module import pkg::*;'."
        echo "  Install sv2v (https://github.com/zachjs/sv2v) and re-run; prove with:"
        echo "    sv2v rtl/power/power_pkg.sv rtl/power/droop_sensor.sv > build/formal/cdc/droop_sensor.lowered.v && sh scripts/run_cdc_formal.sh"
        status_lines="$status_lines $name:blocked_requires_sv2v:$sby_file:$bound_module:$property_pack"
        continue
    fi

    prefix="$work_dir/${name}.$$"
    rm -rf "$prefix"
    if (cd "$props_dir" && sby --prefix "../../$prefix" -f "$sby_file"); then
        st="pass"
    else
        st="fail"
        fail=1
    fi
    canonical="verify/formal/cdc_$name"
    mkdir -p "$canonical"
    [ -f "$prefix/status" ] && cp "$prefix/status" "$canonical/status"
    [ -f "$prefix/logfile.txt" ] && cp "$prefix/logfile.txt" "$canonical/logfile.txt"
    status_lines="$status_lines $name:$st:$sby_file:$bound_module:$property_pack"
done

MANIFEST="$manifest" STATUS_LINES="$status_lines" FAIL="$fail" python3 - <<'PY'
import json, os
from pathlib import Path
manifest = Path(os.environ["MANIFEST"])
tasks = {}
for entry in os.environ["STATUS_LINES"].split():
    name, st, sby, mod, pack = entry.split(":")
    tasks[name] = {
        "status": st,
        "sby": f"verify/properties/{sby}",
        "bound_module": mod,
        "property_pack": f"verify/properties/{pack}",
        "claim_boundary": "intent_manifest_only_not_cdc_rdc_signoff",
    }
statuses = {t["status"] for t in tasks.values()}
if os.environ["FAIL"] == "1" or "fail" in statuses or "missing_sby" in statuses:
    overall = "failed"
elif any(s.startswith("blocked") for s in statuses):
    overall = "blocked"
else:
    overall = "passed"
manifest.write_text(json.dumps({
    "schema": "eliza.cdc_formal_evidence.v1",
    "claim_boundary": "intent_manifest_only_not_cdc_rdc_signoff",
    "status": overall,
    "tasks": tasks,
}, indent=2, sort_keys=True) + "\n")
print(f"CDC formal manifest: {manifest} ({overall})")
PY

# Exit 2 (blocked-on-tooling) when the only non-pass tasks are blocked; exit 1
# only on a real proof failure or missing sby.
final="$(python3 -c "import json;print(json.load(open('$manifest'))['status'])")"
case "$final" in
    failed) exit 1 ;;
    blocked) exit 2 ;;
    *) exit 0 ;;
esac
