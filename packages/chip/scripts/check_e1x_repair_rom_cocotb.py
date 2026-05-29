#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_repair_rom_cocotb.json"
GENERATED_ROM_JSON = ROOT / "benchmarks/results/e1x-scaled-8gb-model-load.high_failure_repair_rom.json"
GENERATED_ROM_HEX = ROOT / "benchmarks/results/e1x-scaled-8gb-model-load.high_failure_repair_rom.hex"
GENERATED_MANIFEST_JSON = ROOT / "benchmarks/results/e1x-scaled-8gb-model-load.high_failure_repair_manifest.json"
REAL_GRAPH_ROM_JSON = ROOT / "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_rom.json"
REAL_GRAPH_ROM_HEX = ROOT / "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_rom.hex"
REAL_GRAPH_MANIFEST_JSON = ROOT / "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_manifest.json"
REAL_GRAPH_NORMAL_ROM_JSON = ROOT / "benchmarks/results/e1x-real-graph-model-load.normal_repair_rom.json"
REAL_GRAPH_NORMAL_ROM_HEX = ROOT / "benchmarks/results/e1x-real-graph-model-load.normal_repair_rom.hex"
REAL_GRAPH_NORMAL_MANIFEST_JSON = ROOT / "benchmarks/results/e1x-real-graph-model-load.normal_repair_manifest.json"
RUNS = {
    "loader": {
        "top": "e1x_repair_rom_loader_tb",
        "module": "test_e1x_repair_rom_loader",
        "result": ROOT / "verify/cocotb/results/e1x_repair_rom_loader_tb_test_e1x_repair_rom_loader.xml",
        "expected": {
            "repair_rom_loader_decodes_header_remaps_and_routes",
            "repair_rom_loader_rejects_bad_magic_and_clear_recovers",
        },
    },
    "state": {
        "top": "e1x_repair_state_tb",
        "module": "test_e1x_repair_state",
        "result": ROOT / "verify/cocotb/results/e1x_repair_state_tb_test_e1x_repair_state.xml",
        "expected": {
            "repair_state_loads_rom_and_serves_remap_route_lookups",
            "repair_state_clear_removes_loaded_records",
            "repair_state_flags_capacity_overflow_and_clear_recovers",
        },
    },
    "route_table_overflow": {
        "top": "e1x_repair_route_table_overflow_tb",
        "module": "test_e1x_repair_route_table_overflow",
        "result": ROOT
        / "verify/cocotb/results/e1x_repair_route_table_overflow_tb_test_e1x_repair_route_table_overflow.xml",
        "expected": {
            "repair_route_table_flags_capacity_overflow_and_clear_recovers",
        },
    },
    "mmio_programmer": {
        "top": "e1x_repair_mmio_programmer_route_table_tb",
        "module": "test_e1x_repair_mmio_programmer",
        "result": ROOT
        / "verify/cocotb/results/e1x_repair_mmio_programmer_route_table_tb_test_e1x_repair_mmio_programmer.xml",
        "expected": {
            "repair_mmio_programmer_loads_route_table_and_serves_lookup",
            "repair_mmio_programmer_reports_invalid_access_and_clear_recovers",
        },
    },
    "generated_loader": {
        "top": "e1x_repair_rom_loader_tb",
        "module": "test_e1x_generated_repair_rom_loader",
        "result": ROOT / "verify/cocotb/results/e1x_repair_rom_loader_tb_test_e1x_generated_repair_rom_loader.xml",
        "expected": {
            "generated_high_failure_repair_rom_streams_through_rtl_loader",
        },
        "env": {
            "E1X_REPAIR_ROM_JSON": str(GENERATED_ROM_JSON),
            "E1X_REPAIR_ROM_HEX": str(GENERATED_ROM_HEX),
        },
    },
    "generated_route_table": {
        "top": "e1x_repair_route_table_tb",
        "module": "test_e1x_generated_repair_route_table",
        "result": ROOT / "verify/cocotb/results/e1x_repair_route_table_tb_test_e1x_generated_repair_route_table.xml",
        "expected": {
            "generated_high_failure_repair_rom_programs_route_table_lookups",
        },
        "env": {
            "E1X_REPAIR_ROM_JSON": str(GENERATED_ROM_JSON),
            "E1X_REPAIR_ROM_HEX": str(GENERATED_ROM_HEX),
            "E1X_REPAIR_MANIFEST_JSON": str(GENERATED_MANIFEST_JSON),
        },
    },
    "real_graph_generated_loader": {
        "top": "e1x_repair_rom_loader_tb",
        "module": "test_e1x_generated_repair_rom_loader",
        "result": ROOT / "verify/cocotb/results/e1x_repair_rom_loader_tb_test_e1x_generated_repair_rom_loader.xml",
        "expected": {
            "generated_high_failure_repair_rom_streams_through_rtl_loader",
        },
        "env": {
            "E1X_REPAIR_ROM_JSON": str(REAL_GRAPH_ROM_JSON),
            "E1X_REPAIR_ROM_HEX": str(REAL_GRAPH_ROM_HEX),
        },
    },
    "real_graph_generated_route_table": {
        "top": "e1x_repair_route_table_tb",
        "module": "test_e1x_generated_repair_route_table",
        "result": ROOT / "verify/cocotb/results/e1x_repair_route_table_tb_test_e1x_generated_repair_route_table.xml",
        "expected": {
            "generated_high_failure_repair_rom_programs_route_table_lookups",
        },
        "env": {
            "E1X_REPAIR_ROM_JSON": str(REAL_GRAPH_ROM_JSON),
            "E1X_REPAIR_ROM_HEX": str(REAL_GRAPH_ROM_HEX),
            "E1X_REPAIR_MANIFEST_JSON": str(REAL_GRAPH_MANIFEST_JSON),
        },
    },
    "real_graph_normal_generated_loader": {
        "top": "e1x_repair_rom_loader_tb",
        "module": "test_e1x_generated_repair_rom_loader",
        "result": ROOT / "verify/cocotb/results/e1x_repair_rom_loader_tb_test_e1x_generated_repair_rom_loader.xml",
        "expected": {
            "generated_high_failure_repair_rom_streams_through_rtl_loader",
        },
        "env": {
            "E1X_REPAIR_ROM_JSON": str(REAL_GRAPH_NORMAL_ROM_JSON),
            "E1X_REPAIR_ROM_HEX": str(REAL_GRAPH_NORMAL_ROM_HEX),
        },
    },
    "real_graph_normal_generated_route_table": {
        "top": "e1x_repair_route_table_tb",
        "module": "test_e1x_generated_repair_route_table",
        "result": ROOT / "verify/cocotb/results/e1x_repair_route_table_tb_test_e1x_generated_repair_route_table.xml",
        "expected": {
            "generated_high_failure_repair_rom_programs_route_table_lookups",
        },
        "env": {
            "E1X_REPAIR_ROM_JSON": str(REAL_GRAPH_NORMAL_ROM_JSON),
            "E1X_REPAIR_ROM_HEX": str(REAL_GRAPH_NORMAL_ROM_HEX),
            "E1X_REPAIR_MANIFEST_JSON": str(REAL_GRAPH_NORMAL_MANIFEST_JSON),
        },
    },
    "generated_mmio_programmer": {
        "top": "e1x_repair_mmio_programmer_route_table_large_tb",
        "module": "test_e1x_generated_repair_mmio_programmer",
        "result": ROOT
        / "verify/cocotb/results/e1x_repair_mmio_programmer_route_table_large_tb_test_e1x_generated_repair_mmio_programmer.xml",
        "expected": {
            "generated_high_failure_repair_rom_programs_route_table_via_mmio",
        },
        "env": {
            "E1X_REPAIR_ROM_JSON": str(GENERATED_ROM_JSON),
            "E1X_REPAIR_ROM_HEX": str(GENERATED_ROM_HEX),
            "E1X_REPAIR_MANIFEST_JSON": str(GENERATED_MANIFEST_JSON),
        },
    },
    "generated_state": {
        "top": "e1x_repair_state_large_tb",
        "module": "test_e1x_generated_repair_state",
        "result": ROOT / "verify/cocotb/results/e1x_repair_state_large_tb_test_e1x_generated_repair_state.xml",
        "expected": {
            "generated_high_failure_repair_rom_programs_large_repair_state",
        },
        "env": {
            "E1X_REPAIR_ROM_JSON": str(GENERATED_ROM_JSON),
            "E1X_REPAIR_ROM_HEX": str(GENERATED_ROM_HEX),
            "E1X_REPAIR_MANIFEST_JSON": str(GENERATED_MANIFEST_JSON),
        },
    },
}


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def ensure_generated_repair_rom() -> None:
    required = (
        GENERATED_ROM_JSON,
        GENERATED_ROM_HEX,
        GENERATED_MANIFEST_JSON,
        REAL_GRAPH_ROM_JSON,
        REAL_GRAPH_ROM_HEX,
        REAL_GRAPH_MANIFEST_JSON,
        REAL_GRAPH_NORMAL_ROM_JSON,
        REAL_GRAPH_NORMAL_ROM_HEX,
        REAL_GRAPH_NORMAL_MANIFEST_JSON,
    )
    if all(path.is_file() for path in required):
        return
    subprocess.run(
        ["scripts/generate_e1x_scaled_model_evidence.py"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=True,
    )


def run_cocotb(top: str, module: str, extra_env: dict[str, str] | None = None) -> tuple[bool, str]:
    env = os.environ.copy()
    env["COCOTB_DIR"] = "verify/cocotb/e1x"
    env["COCOTB_TOPLEVEL"] = top
    env["COCOTB_MODULE"] = module
    if extra_env:
        env.update(extra_env)
    proc = subprocess.run(
        ["scripts/run_cocotb.sh"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        env=env,
        check=False,
    )
    if proc.returncode != 0:
        return False, (proc.stderr.strip() or proc.stdout.strip())[-1200:]
    return True, "cocotb command completed"


def parse_results(result_xml: Path, expected_tests: set[str]) -> tuple[bool, str, dict[str, int]]:
    if not result_xml.is_file():
        return False, f"missing cocotb result {result_xml.relative_to(ROOT)}", {}
    root = ET.fromstring(result_xml.read_text(encoding="utf-8", errors="ignore"))
    cases = list(root.iter("testcase"))
    names = {case.attrib.get("name", "") for case in cases}
    failures = sum(1 for case in cases if case.find("failure") is not None)
    errors = sum(1 for case in cases if case.find("error") is not None)
    missing = sorted(expected_tests - names)
    counts = {
        "testcases": len(cases),
        "failures": failures,
        "errors": errors,
        "missing_expected_tests": len(missing),
    }
    if failures or errors or missing:
        return False, f"failures={failures} errors={errors} missing={','.join(missing)}", counts
    return True, f"{len(cases)} E1X repair-ROM cocotb tests passed", counts


def repair_rom_summary() -> dict[str, int | str]:
    scaled = json.loads(GENERATED_ROM_JSON.read_text(encoding="utf-8"))
    real_graph = json.loads(REAL_GRAPH_ROM_JSON.read_text(encoding="utf-8"))
    real_graph_normal = json.loads(REAL_GRAPH_NORMAL_ROM_JSON.read_text(encoding="utf-8"))
    return {
        "scaled_high_failure_repair_rom_sha256": str(scaled["artifact_sha256"]),
        "scaled_high_failure_repair_rom_words": int(scaled["total_word_count"]),
        "real_graph_high_failure_repair_rom_sha256": str(real_graph["artifact_sha256"]),
        "real_graph_high_failure_repair_rom_words": int(real_graph["total_word_count"]),
        "real_graph_normal_repair_rom_sha256": str(real_graph_normal["artifact_sha256"]),
        "real_graph_normal_repair_rom_words": int(real_graph_normal["total_word_count"]),
    }


def main() -> int:
    ensure_generated_repair_rom()
    checks = []
    aggregate_counts = {"testcases": 0, "failures": 0, "errors": 0, "missing_expected_tests": 0}
    for run_id, run in RUNS.items():
        extra_env = run.get("env")
        if extra_env is not None and not isinstance(extra_env, dict):
            raise TypeError("invalid E1X repair-ROM cocotb env table")
        command_ok, command_detail = run_cocotb(
            str(run["top"]),
            str(run["module"]),
            {str(key): str(value) for key, value in extra_env.items()} if extra_env else None,
        )
        result_path = run["result"]
        expected = run["expected"]
        if not isinstance(result_path, Path) or not isinstance(expected, set):
            raise TypeError("invalid E1X repair-ROM cocotb run table")
        results_ok, results_detail, counts = (
            parse_results(result_path, expected) if command_ok else (False, "not run", {})
        )
        for key in aggregate_counts:
            aggregate_counts[key] += int(counts.get(key, 0))
        checks.extend(
            [
                {
                    "id": f"e1x_repair_rom_{run_id}_cocotb_command",
                    "status": "pass" if command_ok else "fail",
                    "detail": command_detail,
                },
                {
                    "id": f"e1x_repair_rom_{run_id}_cocotb_results",
                    "status": "pass" if results_ok else "fail",
                    "detail": results_detail,
                },
            ]
        )
    failures = [check for check in checks if check["status"] != "pass"]
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-repair-rom-cocotb",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": "E1X repair-ROM loader/state cocotb verification only; not full fuse ROM, firmware, wafer-scale route-table programming, PD, DFT, package, or silicon evidence.",
        "evidence_paths": [
            "rtl/e1x/e1x_repair_rom_loader.sv",
            "rtl/e1x/e1x_repair_mmio_programmer.sv",
            "rtl/e1x/e1x_repair_route_table.sv",
            "rtl/e1x/e1x_repair_state.sv",
            "verify/cocotb/e1x/e1x_repair_rom_loader_tb.sv",
            "verify/cocotb/e1x/e1x_repair_mmio_programmer_route_table_tb.sv",
            "verify/cocotb/e1x/e1x_repair_mmio_programmer_route_table_large_tb.sv",
            "verify/cocotb/e1x/e1x_repair_route_table_tb.sv",
            "verify/cocotb/e1x/e1x_repair_route_table_overflow_tb.sv",
            "verify/cocotb/e1x/e1x_repair_state_tb.sv",
            "verify/cocotb/e1x/e1x_repair_state_large_tb.sv",
            "verify/cocotb/e1x/test_e1x_repair_rom_loader.py",
            "verify/cocotb/e1x/test_e1x_generated_repair_rom_loader.py",
            "verify/cocotb/e1x/test_e1x_generated_repair_route_table.py",
            "verify/cocotb/e1x/test_e1x_generated_repair_mmio_programmer.py",
            "verify/cocotb/e1x/test_e1x_generated_repair_state.py",
            "verify/cocotb/e1x/test_e1x_repair_route_table_overflow.py",
            "verify/cocotb/e1x/test_e1x_repair_mmio_programmer.py",
            "verify/cocotb/e1x/test_e1x_repair_state.py",
            "benchmarks/results/e1x-scaled-8gb-model-load.high_failure_repair_manifest.json",
            "benchmarks/results/e1x-scaled-8gb-model-load.high_failure_repair_rom.json",
            "benchmarks/results/e1x-scaled-8gb-model-load.high_failure_repair_rom.hex",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_manifest.json",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_rom.json",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_rom.hex",
            "benchmarks/results/e1x-real-graph-model-load.normal_repair_manifest.json",
            "benchmarks/results/e1x-real-graph-model-load.normal_repair_rom.json",
            "benchmarks/results/e1x-real-graph-model-load.normal_repair_rom.hex",
            "verify/cocotb/results/e1x_repair_rom_loader_tb_test_e1x_repair_rom_loader.xml",
            "verify/cocotb/results/e1x_repair_mmio_programmer_route_table_tb_test_e1x_repair_mmio_programmer.xml",
            "verify/cocotb/results/e1x_repair_rom_loader_tb_test_e1x_generated_repair_rom_loader.xml",
            "build/reports/cocotb/e1x_repair_mmio_programmer_route_table_large_tb_test_e1x_generated_repair_mmio_programmer.xml",
            "verify/cocotb/results/e1x_repair_route_table_tb_test_e1x_generated_repair_route_table.xml",
            "verify/cocotb/results/e1x_repair_route_table_overflow_tb_test_e1x_repair_route_table_overflow.xml",
            "verify/cocotb/results/e1x_repair_state_tb_test_e1x_repair_state.xml",
            "verify/cocotb/results/e1x_repair_state_large_tb_test_e1x_generated_repair_state.xml",
        ],
        "checks": checks,
        "summary": {
            **aggregate_counts,
            **repair_rom_summary(),
            "check_count": len(checks),
            "failing_check_count": len(failures),
        },
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X repair-ROM cocotb failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X repair-ROM cocotb; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
