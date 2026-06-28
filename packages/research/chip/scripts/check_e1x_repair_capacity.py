#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_repair_capacity.json"
FALSE_CLAIM_FLAGS = {
    "claim_allowed": False,
    "release_claim_allowed": False,
    "production_claim_allowed": False,
    "silicon_claim_allowed": False,
    "tapeout_claim_allowed": False,
    "phone_class_claim_allowed": False,
    "fuse_otp_claim_allowed": False,
}

ROM_CASES = {
    "real_graph_normal": {
        "json": ROOT / "benchmarks/results/e1x-real-graph-model-load.normal_repair_rom.json",
        "hex": ROOT / "benchmarks/results/e1x-real-graph-model-load.normal_repair_rom.hex",
    },
    "real_graph_high_failure": {
        "json": ROOT / "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_rom.json",
        "hex": ROOT / "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_rom.hex",
    },
    "scaled_high_failure": {
        "json": ROOT / "benchmarks/results/e1x-scaled-8gb-model-load.high_failure_repair_rom.json",
        "hex": ROOT / "benchmarks/results/e1x-scaled-8gb-model-load.high_failure_repair_rom.hex",
    },
}

REMAP_ENTRY_BITS = 64
ROUTE_ENTRY_BITS = 128
FUSE_WORD_BITS = 64


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def word_list_sha256(words: list[str]) -> str:
    return sha256(("\n".join(words) + "\n").encode()).hexdigest()


def next_power_of_two(value: int) -> int:
    if value < 1:
        return 1
    return 1 << (value - 1).bit_length()


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def validate_rom_case(
    case: str, json_path: Path, hex_path: Path
) -> tuple[list[dict[str, str]], dict]:
    checks: list[dict[str, str]] = []
    case_summary: dict[str, int | str] = {"case": case}
    paths_exist = json_path.is_file() and hex_path.is_file()
    status, detail = pass_fail(
        paths_exist,
        f"{case} repair ROM JSON/HEX present",
        f"missing {json_path.relative_to(ROOT)} or {hex_path.relative_to(ROOT)}",
    )
    checks.append(
        {"id": f"e1x_repair_capacity_{case}_rom_paths", "status": status, "detail": detail}
    )
    if not paths_exist:
        return checks, case_summary

    rom = load_json(json_path)
    words = rom.get("words", [])
    hex_words = [
        line.strip() for line in hex_path.read_text(encoding="utf-8").splitlines() if line.strip()
    ]
    case_summary.update(
        {
            "rom_sha256": str(rom.get("artifact_sha256", "")),
            "total_word_count": int(rom.get("total_word_count", 0)),
            "header_word_count": int(rom.get("header_word_count", 0)),
            "remap_word_count": int(rom.get("remap_word_count", 0)),
            "route_word_count": int(rom.get("route_sample_word_count", 0)),
        }
    )

    schema_ok = rom.get("schema") == "eliza.e1x.repair_rom.v1"
    status, detail = pass_fail(
        schema_ok,
        f"{case} uses repair ROM schema v1",
        f"{case} schema is {rom.get('schema')}",
    )
    checks.append({"id": f"e1x_repair_capacity_{case}_schema", "status": status, "detail": detail})

    words_ok = (
        isinstance(words, list)
        and all(isinstance(word, str) and len(word) == 16 for word in words)
        and words == hex_words
    )
    status, detail = pass_fail(
        words_ok,
        f"{case} JSON words match HEX sidecar",
        f"{case} JSON/HEX word mismatch",
    )
    checks.append(
        {"id": f"e1x_repair_capacity_{case}_hex_matches_json", "status": status, "detail": detail}
    )

    count_ok = (
        int(rom.get("total_word_count", -1))
        == (
            int(rom.get("header_word_count", -1))
            + int(rom.get("remap_word_count", -1))
            + int(rom.get("route_sample_word_count", -1))
        )
        == len(words)
    )
    status, detail = pass_fail(
        count_ok,
        f"{case} word counts are internally consistent",
        f"{case} inconsistent repair ROM word counts",
    )
    checks.append(
        {"id": f"e1x_repair_capacity_{case}_word_counts", "status": status, "detail": detail}
    )

    sha_ok = word_list_sha256(words) == rom.get("rom_words_sha256")
    status, detail = pass_fail(
        sha_ok,
        f"{case} ROM word SHA matches payload",
        f"{case} ROM word SHA mismatch",
    )
    checks.append(
        {"id": f"e1x_repair_capacity_{case}_word_sha", "status": status, "detail": detail}
    )
    return checks, case_summary


def main() -> int:
    checks: list[dict[str, str]] = []
    cases: list[dict] = []
    for case, paths in ROM_CASES.items():
        case_checks, case_summary = validate_rom_case(case, paths["json"], paths["hex"])
        checks.extend(case_checks)
        cases.append(case_summary)

    max_total_words = max((int(case.get("total_word_count", 0)) for case in cases), default=0)
    max_remap_entries = max((int(case.get("remap_word_count", 0)) for case in cases), default=0)
    max_route_entries = max((int(case.get("route_word_count", 0)) for case in cases), default=0)
    production_fuse_window_words = next_power_of_two(max_total_words)
    production_remap_entries = next_power_of_two(max_remap_entries)
    production_route_entries = next_power_of_two(max_route_entries)
    production_fuse_window_bytes = production_fuse_window_words * FUSE_WORD_BITS // 8
    production_remap_sram_bytes = production_remap_entries * REMAP_ENTRY_BITS // 8
    production_route_sram_bytes = production_route_entries * ROUTE_ENTRY_BITS // 8
    production_dedicated_repair_sram_bytes = (
        production_remap_sram_bytes + production_route_sram_bytes
    )
    local_sram_bytes_per_core = 48 * 1024

    capacity_checks = [
        (
            "fuse_window_fits_all_rom_cases",
            all(
                int(case.get("total_word_count", 0)) <= production_fuse_window_words
                for case in cases
            ),
            f"production fuse/ROM window {production_fuse_window_words}x64b covers all repair ROMs",
        ),
        (
            "remap_sram_fits_high_failure_manifest",
            all(int(case.get("remap_word_count", 0)) <= production_remap_entries for case in cases),
            f"production remap SRAM {production_remap_entries} entries covers all repair ROM remaps",
        ),
        (
            "route_sram_fits_sampled_route_records",
            all(int(case.get("route_word_count", 0)) <= production_route_entries for case in cases),
            f"production route SRAM {production_route_entries} entries covers sampled route records",
        ),
        (
            "dedicated_repair_sram_under_one_core_sram_budget",
            production_dedicated_repair_sram_bytes <= local_sram_bytes_per_core,
            (
                f"dedicated repair SRAM {production_dedicated_repair_sram_bytes} B fits under "
                f"one 48 KiB local-SRAM budget"
            ),
        ),
    ]
    for check_id, condition, detail in capacity_checks:
        status, resolved_detail = pass_fail(condition, detail)
        checks.append(
            {"id": f"e1x_repair_capacity_{check_id}", "status": status, "detail": resolved_detail}
        )

    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "rom_case_count": len(cases),
        "max_total_words": max_total_words,
        "max_remap_entries": max_remap_entries,
        "max_route_entries": max_route_entries,
        "production_fuse_window_words": production_fuse_window_words,
        "production_fuse_window_bytes": production_fuse_window_bytes,
        "production_remap_entries": production_remap_entries,
        "production_route_entries": production_route_entries,
        "production_dedicated_repair_sram_bytes": production_dedicated_repair_sram_bytes,
        "production_dedicated_repair_sram_vs_local_core_sram": (
            production_dedicated_repair_sram_bytes / local_sram_bytes_per_core
        ),
        "rom_cases": cases,
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-repair-capacity",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "false_claim_flags": FALSE_CLAIM_FLAGS,
        "claim_boundary": (
            "E1X production repair fuse/ROM and dedicated repair-SRAM capacity sizing "
            "against generated normal/high-failure architecture-simulation repair images. "
            "This is not silicon fuse burning, OTP macro implementation, or full-wafer "
            "formal liveness evidence."
        ),
        "evidence_paths": [
            "benchmarks/results/e1x-real-graph-model-load.normal_repair_rom.json",
            "benchmarks/results/e1x-real-graph-model-load.normal_repair_rom.hex",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_rom.json",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_rom.hex",
            "benchmarks/results/e1x-scaled-8gb-model-load.high_failure_repair_rom.json",
            "benchmarks/results/e1x-scaled-8gb-model-load.high_failure_repair_rom.hex",
            "rtl/e1x/e1x_repair_state.sv",
            "rtl/e1x/e1x_repair_route_table.sv",
            "scripts/check_e1x_repair_capacity.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X repair capacity failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X repair capacity; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
