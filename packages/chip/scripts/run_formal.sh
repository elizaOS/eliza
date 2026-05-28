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

if mode == "fallback":
    add("e1_dbg_mmio_bridge", "blocked_requires_sby", None, None)
    add("e1_npu", "fallback_structural_only", None, root / "build/reports/e1_npu_formal_yosys.log")
    add("e1_dma", "fallback_yosys_sat", None, root / "build/reports/e1_dma_formal_yosys.log")
    add("e1_soc_top", "fallback_structural_only", None, root / "build/reports/e1_soc_top_formal_yosys.log")
elif mode == "sby-shallow-top":
    add("e1_dbg_mmio_bridge", "sby_bmc", root / "verify/formal/e1_dbg_mmio_bridge/status", root / "verify/formal/e1_dbg_mmio_bridge/logfile.txt")
    add("e1_npu", "sby_bmc", root / "verify/formal/e1_npu/status", root / "verify/formal/e1_npu/logfile.txt")
    add("e1_dma", "sby_bmc", root / "verify/formal/e1_dma/status", root / "verify/formal/e1_dma/logfile.txt")
    add("e1_soc_top", "fallback_structural_only", None, root / "build/reports/e1_soc_top_formal_yosys.log")
else:
    add("e1_dbg_mmio_bridge", "sby_bmc", root / "verify/formal/e1_dbg_mmio_bridge/status", root / "verify/formal/e1_dbg_mmio_bridge/logfile.txt")
    add("e1_npu", "sby_bmc", root / "verify/formal/e1_npu/status", root / "verify/formal/e1_npu/logfile.txt")
    add("e1_dma", "sby_bmc", root / "verify/formal/e1_dma/status", root / "verify/formal/e1_dma/logfile.txt")
    add("e1_soc_top", "sby_bmc_deep", root / "verify/formal/e1_soc_top/status", root / "verify/formal/e1_soc_top/logfile.txt")

sources = {}
for pattern in ("rtl/**/*.sv", "verify/formal/*.sv", "verify/formal/*.sby", "scripts/yosys_formal_*.ys", "scripts/run_formal.sh"):
    for path in sorted(root.glob(pattern)):
        if path.is_file():
            sources[path.relative_to(root).as_posix()] = sha256(path)

manifest = {
    "schema": "e1-chip-formal-evidence-v1",
    "generated_at_utc": datetime.now(timezone.utc).isoformat(),
    "mode": mode,
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

    rm -rf "$prefix"
    sby --prefix "$prefix" -f "$spec"
    mkdir -p "$canonical"
    cp "$prefix/status" "$canonical/status"
    cp "$prefix/logfile.txt" "$canonical/logfile.txt"
}

run_sby e1_dbg_mmio_bridge
run_sby e1_npu
run_sby e1_dma
python3 verify/check_formal_engine_agreement.py \
    verify/formal/e1_dbg_mmio_bridge \
    verify/formal/e1_npu \
    verify/formal/e1_dma
if [ "${REQUIRE_DEEP_FORMAL:-0}" = "1" ]; then
    run_sby e1_soc_top
    python3 verify/check_formal_engine_agreement.py verify/formal/e1_soc_top
    write_manifest sby-deep-top
else
    echo "Running structural top-level formal for routine CI. Set REQUIRE_DEEP_FORMAL=1 for the deeper e1_soc_top SymbiYosys BMC."
    yosys -q -l build/reports/e1_soc_top_formal_yosys.log scripts/yosys_formal_top_structural.ys
    write_manifest sby-shallow-top
fi
