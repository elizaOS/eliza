#!/usr/bin/env sh
set -eu

repo_dir="$(CDPATH=; cd -- "$(dirname -- "$0")/.." && pwd)"
if [ -d "$repo_dir/external/oss-cad-suite/bin" ]; then
    PATH="$repo_dir/external/oss-cad-suite/bin:$PATH"
fi

mkdir -p build/reports build/formal verify/formal/work

write_manifest() {
    mode="$1"
    python3 - "$mode" <<'PY'
from datetime import datetime, timezone
import hashlib
import json
import re
from pathlib import Path
import sys

root = Path.cwd()
mode = sys.argv[1]
entries = {}

def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def parse_sby(path: Path) -> dict:
    if not path.is_file():
        return {}
    sections: dict[str, list[str]] = {}
    current: str | None = None
    for raw_line in path.read_text(errors="ignore").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        match = re.fullmatch(r"\[([^]]+)\]", line)
        if match:
            current = match.group(1)
            sections.setdefault(current, [])
            continue
        if current:
            sections[current].append(line)

    engines = [line for line in sections.get("engines", []) if line]
    tasks = [line for line in sections.get("tasks", []) if line]
    if not tasks:
        tasks = ["default"]

    defaults: dict[str, str] = {}
    task_options: dict[str, dict[str, str]] = {task: {} for task in tasks}
    for line in sections.get("options", []):
        if ":" in line:
            task, rest = line.split(":", 1)
            fields = rest.strip().split(None, 1)
            if len(fields) == 2:
                task_options.setdefault(task.strip(), {})[fields[0]] = fields[1]
            continue
        fields = line.split(None, 1)
        if len(fields) == 2:
            defaults[fields[0]] = fields[1]

    task_meta = {}
    for task in tasks:
        merged = dict(defaults)
        merged.update(task_options.get(task, {}))
        task_meta[task] = merged

    files = [line for line in sections.get("files", []) if line]
    return {
        "spec": path.relative_to(root).as_posix(),
        "engines": engines,
        "tasks": task_meta,
        "covered_files": files,
    }

def add(name: str, evidence_class: str, status_path: Path | None, log_path: Path | None) -> None:
    paths = {}
    status = "missing"
    if status_path and status_path.is_file():
        rel = status_path.relative_to(root).as_posix()
        paths["status"] = rel
        paths["status_sha256"] = sha256(status_path)
        text = status_path.read_text(errors="ignore")
        status = "pass" if "PASS" in text else "fail"
    if log_path and log_path.is_file():
        rel = log_path.relative_to(root).as_posix()
        paths["log"] = rel
        paths["log_sha256"] = sha256(log_path)
        if status == "missing" and evidence_class.startswith("fallback"):
            status = "fallback_pass"
    entries[name] = {
        "status": status,
        "evidence_class": evidence_class,
        "paths": paths,
    }
    sby_meta = parse_sby(root / f"verify/formal/{name}.sby")
    if sby_meta:
        entries[name]["sby"] = sby_meta

if mode == "fallback":
    add("e1_dbg_mmio_bridge", "blocked_requires_sby", None, None)
    add("e1_npu", "fallback_structural_only", None, root / "build/reports/e1_npu_formal_yosys.log")
    add("e1_dma", "fallback_yosys_sat", None, root / "build/reports/e1_dma_formal_yosys.log")
    add("e1_dma_axil", "blocked_requires_sby", None, None)
    add("e1_display_scanout", "blocked_requires_sby", None, None)
    add("e1_axi_lite_dram", "blocked_requires_sby", None, None)
    add("e1_axi_lite_interconnect", "blocked_requires_sby", None, None)
    add("e1_interrupt_controller", "blocked_requires_sby", None, None)
    add("e1_soc_top", "fallback_structural_only", None, root / "build/reports/e1_soc_top_formal_yosys.log")
elif mode == "sby-shallow-top":
    add("e1_dbg_mmio_bridge", "sby_bmc", root / "verify/formal/e1_dbg_mmio_bridge/status", root / "verify/formal/e1_dbg_mmio_bridge/logfile.txt")
    add("e1_npu", "sby_bmc", root / "verify/formal/e1_npu/status", root / "verify/formal/e1_npu/logfile.txt")
    add("e1_dma", "sby_bmc", root / "verify/formal/e1_dma/status", root / "verify/formal/e1_dma/logfile.txt")
    add("e1_dma_axil", "sby_bmc", root / "verify/formal/e1_dma_axil/status", root / "verify/formal/e1_dma_axil/logfile.txt")
    add("e1_display_scanout", "sby_bmc", root / "verify/formal/e1_display_scanout/status", root / "verify/formal/e1_display_scanout/logfile.txt")
    add("e1_axi_lite_dram", "sby_bmc", root / "verify/formal/e1_axi_lite_dram/status", root / "verify/formal/e1_axi_lite_dram/logfile.txt")
    add("e1_axi_lite_interconnect", "sby_bmc", root / "verify/formal/e1_axi_lite_interconnect/status", root / "verify/formal/e1_axi_lite_interconnect/logfile.txt")
    add("e1_interrupt_controller", "sby_bmc", root / "verify/formal/e1_interrupt_controller/status", root / "verify/formal/e1_interrupt_controller/logfile.txt")
    add("e1_soc_top", "fallback_structural_only", None, root / "build/reports/e1_soc_top_formal_yosys.log")
else:
    add("e1_dbg_mmio_bridge", "sby_bmc", root / "verify/formal/e1_dbg_mmio_bridge/status", root / "verify/formal/e1_dbg_mmio_bridge/logfile.txt")
    add("e1_npu", "sby_bmc", root / "verify/formal/e1_npu/status", root / "verify/formal/e1_npu/logfile.txt")
    add("e1_dma", "sby_bmc", root / "verify/formal/e1_dma/status", root / "verify/formal/e1_dma/logfile.txt")
    add("e1_dma_axil", "sby_bmc", root / "verify/formal/e1_dma_axil/status", root / "verify/formal/e1_dma_axil/logfile.txt")
    add("e1_display_scanout", "sby_bmc", root / "verify/formal/e1_display_scanout/status", root / "verify/formal/e1_display_scanout/logfile.txt")
    add("e1_axi_lite_dram", "sby_bmc", root / "verify/formal/e1_axi_lite_dram/status", root / "verify/formal/e1_axi_lite_dram/logfile.txt")
    add("e1_axi_lite_interconnect", "sby_bmc", root / "verify/formal/e1_axi_lite_interconnect/status", root / "verify/formal/e1_axi_lite_interconnect/logfile.txt")
    add("e1_interrupt_controller", "sby_bmc", root / "verify/formal/e1_interrupt_controller/status", root / "verify/formal/e1_interrupt_controller/logfile.txt")
    add("e1_soc_top", "sby_bmc_deep", root / "verify/formal/e1_soc_top/status", root / "verify/formal/e1_soc_top/logfile.txt")

sources = {}
for pattern in ("rtl/**/*.sv", "verify/formal/*.sv", "verify/formal/*.sby", "scripts/yosys_formal_*.ys", "scripts/run_formal.sh"):
    for path in sorted(root.glob(pattern)):
        if path.is_file():
            sources[path.relative_to(root).as_posix()] = sha256(path)

manifest = {
    "schema": "e1-chip-formal-evidence-v1",
    "generated_at_utc": datetime.now(timezone.utc).isoformat(),
    "generated_utc": datetime.now(timezone.utc).isoformat(),
    "claim_boundary": "formal_manifest_execution_inventory_only_not_full_release_evidence",
    "mode": mode,
    "fallback_equivalent_to_sby": False,
    "strict_release_claim_allowed": mode == "sby-deep-top",
    "deep_top_required_for_release": True,
    "release_claim": "strict_requires_sby_and_deep_top" if mode != "sby-deep-top" else "strict_formal_bmc_evidence",
    "entries": entries,
    "source_hashes": sources,
}
out = root / "build/reports/formal_manifest.json"
out.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
print(f"Formal evidence manifest: {out.relative_to(root)} ({mode})")
PY
}

if ! command -v sby >/dev/null 2>&1; then
    if [ "${REQUIRE_SBY:-0}" = "1" ]; then
        echo "SymbiYosys is required for this target; refusing Yosys fallback."
        exit 1
    fi
    if command -v yosys >/dev/null 2>&1; then
        echo "SymbiYosys missing; running Yosys SAT fallback."
        echo "Bridge formal requires SymbiYosys; fallback covers legacy blocks only."
        yosys -q -l build/reports/e1_soc_top_formal_yosys.log scripts/yosys_formal_top_structural.ys
        yosys -q -l build/reports/e1_npu_formal_yosys.log scripts/yosys_formal_npu_structural.ys
        yosys -q -l build/reports/e1_dma_formal_yosys.log scripts/yosys_formal_dma.ys
        echo "Yosys formal fallback reports: build/reports/e1_*_formal_yosys.log"
        write_manifest fallback
        exit 0
    fi
    echo "SymbiYosys and Yosys are missing. Use Docker/Nix or add formal tools to PATH."
    exit 1
fi

run_sby() {
    name="$1"
    spec="verify/formal/$name.sby"
    prefix="build/formal/${name}.$$"
    canonical="verify/formal/$name"

    rm -rf "$prefix" "$prefix"_*
    sby --prefix "$prefix" -f "$spec"
    mkdir -p "$canonical"
    if [ -f "$prefix/status" ]; then
        cp "$prefix/status" "$canonical/status"
        cp "$prefix/logfile.txt" "$canonical/logfile.txt"
        return
    fi

    : >"$canonical/status"
    : >"$canonical/logfile.txt"
    found_task=0
    for result_dir in "$prefix"_*; do
        [ -f "$result_dir/status" ] || continue
        found_task=1
        task_name="${result_dir#"$prefix""_"}"
        {
            printf '== %s ==\n' "$task_name"
            cat "$result_dir/status"
        } >>"$canonical/status"
        {
            printf '== %s ==\n' "$task_name"
            cat "$result_dir/logfile.txt"
        } >>"$canonical/logfile.txt"
    done
    if [ "$found_task" -ne 1 ]; then
        echo "missing SymbiYosys status for $name under $prefix"
        exit 1
    fi
}

check_engine_agreement() {
    python3 verify/check_formal_engine_agreement.py "$@"
}

run_sby e1_dbg_mmio_bridge
run_sby e1_npu
run_sby e1_dma
run_sby e1_dma_axil
run_sby e1_display_scanout
run_sby e1_axi_lite_dram
run_sby e1_axi_lite_interconnect
run_sby e1_interrupt_controller
check_engine_agreement \
    verify/formal/e1_dbg_mmio_bridge \
    verify/formal/e1_npu \
    verify/formal/e1_dma \
    verify/formal/e1_dma_axil \
    verify/formal/e1_display_scanout \
    verify/formal/e1_axi_lite_dram \
    verify/formal/e1_axi_lite_interconnect \
    verify/formal/e1_interrupt_controller
if [ "${REQUIRE_DEEP_FORMAL:-0}" = "1" ]; then
    run_sby e1_soc_top
    check_engine_agreement verify/formal/e1_soc_top
    write_manifest sby-deep-top
else
    echo "Running structural top-level formal for routine CI. Set REQUIRE_DEEP_FORMAL=1 for the deeper e1_soc_top SymbiYosys BMC."
    yosys -q -l build/reports/e1_soc_top_formal_yosys.log scripts/yosys_formal_top_structural.ys
    write_manifest sby-shallow-top
fi
