#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_evidence_bundle.json"

REQUIRED_REPORTS = {
    "benchmark": ROOT / "build/reports/e1x_benchmark.json",
    "graph_mapper": ROOT / "build/reports/e1x_graph_mapper.json",
    "kernel_codegen": ROOT / "build/reports/e1x_kernel_codegen.json",
    "core_cocotb": ROOT / "build/reports/e1x_core_cocotb.json",
    "pe_core_cocotb": ROOT / "build/reports/e1x_pe_core_cocotb.json",
    "repair_rom_cocotb": ROOT / "build/reports/e1x_repair_rom_cocotb.json",
    "boot_repair_fw": ROOT / "build/reports/e1x_boot_repair_fw.json",
    "tile_cocotb": ROOT / "build/reports/e1x_tile_cocotb.json",
    "dft_cocotb": ROOT / "build/reports/e1x_dft_cocotb.json",
    "fabric_cocotb": ROOT / "build/reports/e1x_fabric_cocotb.json",
    "formal": ROOT / "build/reports/e1x_formal.json",
    "rtl_contract": ROOT / "build/reports/e1x_rtl_contract.json",
}

NORMAL_ROM_SHA = "7911d1a3f892202baa2f39f6277d7efda42ac1d7a35e37c9bc3b597f8473cd97"
HIGH_ROM_SHA = "9f2710a5266260fe9885f22954d14f3e6787840d5c6b0bf36781a051e42e29da"
FRESHNESS_SKEW = timedelta(seconds=2)


def load_report(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_report_time(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    text = value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def resolve_evidence_path(value: str) -> Path:
    path = ROOT / value
    if path.is_file():
        return path
    if value.startswith("verify/cocotb/results/"):
        archive_path = ROOT / "build/reports/cocotb" / Path(value).name
        if archive_path.is_file():
            return archive_path
    return path


def check_reports_present(reports: dict[str, dict]) -> list[dict[str, str]]:
    checks = []
    for name, path in REQUIRED_REPORTS.items():
        exists = path.is_file()
        status, detail = pass_fail(
            exists,
            f"{path.relative_to(ROOT)} present",
            f"missing {path.relative_to(ROOT)}",
        )
        checks.append({"id": f"e1x_bundle_{name}_report_present", "status": status, "detail": detail})
        if exists:
            reports[name] = load_report(path)
    return checks


def check_report_passes(name: str, report: dict) -> dict[str, str]:
    status, detail = pass_fail(
        report.get("status") == "PASS",
        f"{name} report status PASS",
        f"{name} report status is {report.get('status')}",
    )
    return {"id": f"e1x_bundle_{name}_status", "status": status, "detail": detail}


def check_report_evidence_paths(name: str, report: dict) -> list[dict[str, str]]:
    evidence_paths = report.get("evidence_paths")
    if not isinstance(evidence_paths, list) or not evidence_paths:
        return [
            {
                "id": f"e1x_bundle_{name}_evidence_paths_declared",
                "status": "fail",
                "detail": f"{name} report declares no evidence_paths",
            }
        ]
    missing = []
    invalid = []
    for value in evidence_paths:
        if not isinstance(value, str) or not value or Path(value).is_absolute():
            invalid.append(str(value))
            continue
        path = resolve_evidence_path(value)
        if not path.is_file():
            missing.append(value)
    checks = [
        {
            "id": f"e1x_bundle_{name}_evidence_paths_declared",
            "status": "pass",
            "detail": f"{len(evidence_paths)} evidence paths declared",
        }
    ]
    status, detail = pass_fail(
        not invalid and not missing,
        f"all {len(evidence_paths)} {name} evidence paths exist",
        "invalid evidence paths: "
        + ", ".join(invalid[:5])
        + ("; " if invalid and missing else "")
        + "missing evidence paths: "
        + ", ".join(missing[:5]),
    )
    checks.append({
        "id": f"e1x_bundle_{name}_evidence_paths_exist",
        "status": status,
        "detail": detail,
    })
    return checks


def check_report_freshness(name: str, report: dict) -> dict[str, str]:
    report_time = parse_report_time(report.get("generated_utc") or report.get("as_of"))
    if report_time is None:
        return {
            "id": f"e1x_bundle_{name}_freshness",
            "status": "fail",
            "detail": f"{name} report has no parseable generated_utc/as_of timestamp",
        }
    evidence_paths = report.get("evidence_paths")
    if not isinstance(evidence_paths, list) or not evidence_paths:
        return {
            "id": f"e1x_bundle_{name}_freshness",
            "status": "fail",
            "detail": f"{name} report has no evidence paths for freshness checking",
        }
    newest: tuple[datetime, str] | None = None
    for value in evidence_paths:
        if not isinstance(value, str) or not value or Path(value).is_absolute():
            continue
        path = resolve_evidence_path(value)
        if not path.is_file():
            continue
        mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=UTC)
        if newest is None or mtime > newest[0]:
            newest = (mtime, value)
    if newest is None:
        return {
            "id": f"e1x_bundle_{name}_freshness",
            "status": "fail",
            "detail": f"{name} report has no existing evidence paths for freshness checking",
        }
    fresh = report_time + FRESHNESS_SKEW >= newest[0]
    status, detail = pass_fail(
        fresh,
        f"{name} report timestamp covers newest evidence path {newest[1]}",
        f"{name} report timestamp {report_time.isoformat()} is older than {newest[1]} mtime {newest[0].isoformat()}",
    )
    return {"id": f"e1x_bundle_{name}_freshness", "status": status, "detail": detail}


def main() -> int:
    reports: dict[str, dict] = {}
    checks = check_reports_present(reports)
    checks.extend(
        check_report_passes(name, report)
        for name, report in sorted(reports.items())
    )
    for name, report in sorted(reports.items()):
        checks.extend(check_report_evidence_paths(name, report))
        checks.append(check_report_freshness(name, report))

    benchmark = reports.get("benchmark", {}).get("summary", {})
    repair_rom = reports.get("repair_rom_cocotb", {}).get("summary", {})
    boot_fw = reports.get("boot_repair_fw", {}).get("summary", {})
    tile = reports.get("tile_cocotb", {}).get("summary", {})
    kernel = reports.get("kernel_codegen", {}).get("summary", {})
    graph_mapper = reports.get("graph_mapper", {}).get("summary", {})
    core = reports.get("core_cocotb", {}).get("summary", {})
    pe_core = reports.get("pe_core_cocotb", {}).get("summary", {})
    dft = reports.get("dft_cocotb", {}).get("summary", {})

    bundle_requirements = [
        (
            "real_graph_13b_8gb_model_fits_e1x_not_e1",
            float(benchmark.get("real_graph_model_required_vs_e1_sram", 0.0)) > 100.0
            and 0.0 < float(benchmark.get("real_graph_model_required_vs_e1x_sram", 0.0)) < 1.0,
            "real graph resident model needs >100x E1 SRAM and fits within E1X SRAM",
        ),
        (
            "real_graph_normal_and_high_execution_traces",
            int(benchmark.get("real_graph_normal_execution_trace_cycles", 0)) > 0
            and int(benchmark.get("real_graph_high_failure_execution_trace_cycles", 0)) > 0
            and float(benchmark.get("real_graph_high_vs_normal_trace_cycle_ratio", 0.0)) >= 1.0,
            "normal/high real-graph execution traces exist and high-failure is no faster",
        ),
        (
            "real_graph_repair_roms_benchmark_gated",
            benchmark.get("real_graph_normal_repair_rom_sha256") == NORMAL_ROM_SHA
            and benchmark.get("real_graph_high_failure_repair_rom_sha256") == HIGH_ROM_SHA
            and int(benchmark.get("real_graph_high_failure_repair_rom_words", 0))
            > int(benchmark.get("real_graph_normal_repair_rom_words", 0)),
            "benchmark gates normal/high real-graph repair ROM sidecars",
        ),
        (
            "real_graph_repair_roms_rtl_loader_route_table",
            repair_rom.get("real_graph_normal_repair_rom_sha256") == NORMAL_ROM_SHA
            and repair_rom.get("real_graph_high_failure_repair_rom_sha256") == HIGH_ROM_SHA
            and int(repair_rom.get("testcases", 0)) >= 16
            and int(repair_rom.get("failing_check_count", 1)) == 0,
            "repair-ROM cocotb covers normal/high real-graph ROM loader and route-table paths",
        ),
        (
            "real_graph_repair_roms_boot_firmware",
            int(boot_fw.get("verified_rom_case_count", 0)) >= 3
            and bool(boot_fw.get("native_verification_passed")) is True
            and int(boot_fw.get("failing_check_count", 1)) == 0
            and int(boot_fw.get("blocked_check_count", 1)) == 0,
            "boot firmware streams scaled and real-graph repair ROM cases",
        ),
        (
            "real_graph_repair_roms_tile_mmio",
            tile.get("real_graph_normal_repair_rom_sha256") == NORMAL_ROM_SHA
            and tile.get("real_graph_high_failure_repair_rom_sha256") == HIGH_ROM_SHA
            and int(tile.get("testcases", 0)) >= 12
            and int(tile.get("failing_check_count", 1)) == 0,
            "tile cocotb programs normal/high real-graph ROMs through MMIO and reroutes wavelets",
        ),
        (
            "real_graph_kernel_schedule_present",
            int(kernel.get("programmed_layer_count", kernel.get("real_graph_kernel_dispatch_layers", 0))) >= 283
            or int(benchmark.get("real_graph_kernel_dispatch_layers", 0)) >= 283,
            "real-graph kernel dispatch covers the checked layer graph",
        ),
        (
            "real_graph_mapper_placement_present",
            int(graph_mapper.get("passing_check_count", 0)) >= 8
            and not graph_mapper.get("failures", [1]),
            "graph mapper report covers manifest parsing, 13B placement, SRAM fit, colors, determinism, and wafer consistency",
        ),
        (
            "tiny_core_and_pe_core_cocotb_present",
            int(core.get("testcases", 0)) >= 22
            and int(pe_core.get("testcases", 0)) >= 16
            and int(core.get("failing_check_count", 1)) == 0
            and int(pe_core.get("failing_check_count", 1)) == 0,
            "tiny-core, local-SRAM loader, PE-core, and generated W4A8 PE execution cocotb coverage is present",
        ),
        (
            "sram_ecc_mbist_dft_cocotb_present",
            int(dft.get("testcases", 0)) >= 7
            and int(dft.get("failing_check_count", 1)) == 0
            and int(dft.get("failures", 1)) == 0
            and int(dft.get("errors", 1)) == 0,
            "local SRAM ECC and MBIST DFT cocotb coverage is present",
        ),
        (
            "fabric_schedule_uses_high_failure_repair_penalty",
            float(benchmark.get("real_graph_schedule_execution_repair_hop_penalty", -1.0))
            == float(benchmark.get("real_graph_high_failure_repair_hop_penalty", -2.0))
            and int(benchmark.get("real_graph_fabric_color_used_colors", 0)) == 24,
            "schedule/fabric evidence uses high-failure repair penalty and all routing colors",
        ),
    ]
    for req_id, condition, detail in bundle_requirements:
        status, resolved_detail = pass_fail(condition, detail)
        checks.append({"id": f"e1x_bundle_{req_id}", "status": status, "detail": resolved_detail})

    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "evidence_path_check_count": len(
            [check for check in checks if check["id"].endswith("_evidence_paths_exist")]
        ),
        "freshness_check_count": len(
            [check for check in checks if check["id"].endswith("_freshness")]
        ),
        "real_graph_normal_repair_rom_sha256": str(benchmark.get("real_graph_normal_repair_rom_sha256", "")),
        "real_graph_high_failure_repair_rom_sha256": str(benchmark.get("real_graph_high_failure_repair_rom_sha256", "")),
        "real_graph_model_required_mib": float(benchmark.get("real_graph_model_required_mib", 0.0)),
        "real_graph_model_required_vs_e1_sram": float(benchmark.get("real_graph_model_required_vs_e1_sram", 0.0)),
        "real_graph_model_required_vs_e1x_sram": float(benchmark.get("real_graph_model_required_vs_e1x_sram", 0.0)),
        "real_graph_high_vs_normal_trace_cycle_ratio": float(
            benchmark.get("real_graph_high_vs_normal_trace_cycle_ratio", 0.0)
        ),
        "boot_verified_rom_case_count": int(boot_fw.get("verified_rom_case_count", 0)),
        "repair_rom_cocotb_testcases": int(repair_rom.get("testcases", 0)),
        "tile_cocotb_testcases": int(tile.get("testcases", 0)),
        "core_cocotb_testcases": int(core.get("testcases", 0)),
        "pe_core_cocotb_testcases": int(pe_core.get("testcases", 0)),
        "dft_cocotb_testcases": int(dft.get("testcases", 0)),
        "graph_mapper_passing_check_count": int(graph_mapper.get("passing_check_count", 0)),
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-evidence-bundle",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Aggregate E1X evidence-bundle gate over existing architecture, benchmark, "
            "firmware, RTL/cocotb, and formal reports. It checks current report contents "
            "and artifact linkage; it is not silicon, package, PD, foundry DFT, or "
            "cycle-accurate full-wafer execution evidence."
        ),
        "evidence_paths": [str(path.relative_to(ROOT)) for path in REQUIRED_REPORTS.values()],
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X evidence bundle failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X evidence bundle; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
