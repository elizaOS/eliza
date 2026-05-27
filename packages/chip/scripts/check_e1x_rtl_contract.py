#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from compiler.runtime.e1x_wafer_model import E1XConfig, build_e1x_report  # noqa: E402

REPORT = ROOT / "build/reports/e1x_rtl_contract.json"
RTL_FILES = [
    ROOT / "rtl/e1x/e1x_pkg.sv",
    ROOT / "rtl/e1x/e1x_mesh_router.sv",
    ROOT / "rtl/e1x/e1x_tiny_core_contract.sv",
    ROOT / "rtl/e1x/e1x_tile.sv",
]


def read_param(text: str, name: str) -> int:
    match = re.search(rf"parameter\s+int\s+{re.escape(name)}\s*=\s*(\d+)\s*;", text)
    if not match:
        raise ValueError(f"missing parameter {name}")
    return int(match.group(1))


def structural_checks() -> list[dict[str, str]]:
    checks: list[dict[str, str]] = []
    missing = [str(path.relative_to(ROOT)) for path in RTL_FILES if not path.is_file()]
    checks.append(
        {
            "id": "e1x_rtl_sources_present",
            "status": "pass" if not missing else "fail",
            "detail": "all E1X RTL contract sources present"
            if not missing
            else "missing: " + ", ".join(missing),
        }
    )
    if missing:
        return checks

    pkg = (ROOT / "rtl/e1x/e1x_pkg.sv").read_text(encoding="utf-8")
    cfg = E1XConfig()
    expected = {
        "E1X_LOGICAL_ROWS": cfg.logical_rows,
        "E1X_LOGICAL_COLS": cfg.logical_cols,
        "E1X_SPARE_ROWS": cfg.spare_rows,
        "E1X_SPARE_COLS": cfg.spare_cols,
        "E1X_LOCAL_SRAM_KIB": cfg.local_sram_kib_per_core,
        "E1X_FABRIC_PAYLOAD_BITS": cfg.fabric_payload_bits,
        "E1X_ROUTING_COLORS": cfg.routing_colors,
    }
    mismatches = []
    for name, value in expected.items():
        try:
            actual = read_param(pkg, name)
        except ValueError as exc:
            mismatches.append(str(exc))
            continue
        if actual != value:
            mismatches.append(f"{name}: rtl={actual} model={value}")
    checks.append(
        {
            "id": "e1x_rtl_params_match_model",
            "status": "pass" if not mismatches else "fail",
            "detail": "RTL package constants match E1XConfig"
            if not mismatches
            else "; ".join(mismatches),
        }
    )

    tile = (ROOT / "rtl/e1x/e1x_tile.sv").read_text(encoding="utf-8")
    required_instances = ("e1x_mesh_router", "e1x_tiny_core_contract")
    missing_instances = [name for name in required_instances if name not in tile]
    checks.append(
        {
            "id": "e1x_tile_binds_core_and_router",
            "status": "pass" if not missing_instances else "fail",
            "detail": "tile instantiates router and tiny-core contract"
            if not missing_instances
            else "missing instances: " + ", ".join(missing_instances),
        }
    )
    tile_terms = (
        "core_instr_valid_i",
        "core_instr_i",
        "core_x1_o",
        "core_x2_o",
        "core_x3_o",
        "core_x10_o",
        "core_halted_o",
        "core_active_o",
    )
    missing_tile_terms = [term for term in tile_terms if term not in tile]
    checks.append(
        {
            "id": "e1x_tile_exposes_core_instruction_and_state",
            "status": "pass" if not missing_tile_terms else "fail",
            "detail": "tile exposes instruction feed and core architectural state for integration evidence"
            if not missing_tile_terms
            else "missing terms: " + ", ".join(missing_tile_terms),
        }
    )

    router = (ROOT / "rtl/e1x/e1x_mesh_router.sv").read_text(encoding="utf-8")
    router_terms = ("route_table_i", "port_disable_i", "repair_enable_i", "repaired_drop_o")
    missing_terms = [term for term in router_terms if term not in router]
    checks.append(
        {
            "id": "e1x_router_exposes_repair_controls",
            "status": "pass" if not missing_terms else "fail",
            "detail": "router exposes route table, port disable, repair enable, and repaired-drop output"
            if not missing_terms
            else "missing terms: " + ", ".join(missing_terms),
        }
    )
    return checks


def model_checks() -> list[dict[str, str]]:
    report = build_e1x_report()
    defect = report["defect_testing"]
    return [
        {
            "id": "e1x_model_repairs_defect_map",
            "status": "pass" if defect["repaired_logical_mesh"] is True else "fail",
            "detail": (
                f"{defect['logical_neighbor_paths_checked']} logical neighbor routes checked; "
                f"max repaired neighbor hops={defect['max_repaired_neighbor_hops']}"
            ),
        },
        {
            "id": "e1x_model_keeps_e1_comparison",
            "status": "pass"
            if report["comparison"]["e1"]["basis"] == "open_2028_sota_160tops"
            else "fail",
            "detail": "E1 comparison remains tied to the existing Ariane/CVA6 NPU model",
        },
    ]


def verilator_check() -> dict[str, str]:
    verilator = shutil.which("verilator") or str(ROOT / "external/oss-cad-suite/bin/verilator")
    if not Path(verilator).is_file():
        return {
            "id": "e1x_verilator_lint",
            "status": "blocked",
            "detail": "verilator unavailable; structural RTL contract checks still ran",
        }
    cmd = [
        verilator,
        "--lint-only",
        "-Wall",
        "-Wno-DECLFILENAME",
        "-Wno-UNUSEDPARAM",
        "-Wno-UNUSEDSIGNAL",
        "-Wno-BLKSEQ",
        str(ROOT / "rtl/e1x/e1x_mesh_router.sv"),
        str(ROOT / "rtl/e1x/e1x_tiny_core_contract.sv"),
        str(ROOT / "rtl/e1x/e1x_tile.sv"),
        "--top-module",
        "e1x_tile",
    ]
    proc = subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True, check=False)
    detail = (proc.stderr.strip() or proc.stdout.strip() or "lint clean")[-1000:]
    return {
        "id": "e1x_verilator_lint",
        "status": "pass" if proc.returncode == 0 else "fail",
        "detail": detail,
    }


def main() -> int:
    checks = structural_checks() + model_checks() + [verilator_check()]
    failures = [check for check in checks if check["status"] == "fail"]
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-rtl-contract-check",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "subsystem": "e1x",
        "claim_boundary": "E1X RTL contract and architecture-model consistency only; not a complete RISC-V core, wafer-scale RTL, PD, DFT, package, or silicon claim.",
        "checks": checks,
        "summary": {
            "check_count": len(checks),
            "passing_check_count": sum(1 for check in checks if check["status"] == "pass"),
            "blocked_check_count": sum(1 for check in checks if check["status"] == "blocked"),
            "failing_check_count": len(failures),
        },
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X RTL contract failures: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X RTL contract check; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
