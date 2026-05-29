#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_window_repair_rom_linkage.json"

PLACEMENT = ROOT / "benchmarks/results/e1x-real-graph-model-load.placement.json"
WINDOW_REPAIR = ROOT / "build/reports/e1x_window_repair_linkage.json"
WINDOW_ROUTE = ROOT / "build/reports/e1x_window_route_validation.json"
REPAIR_ROM_COCOTB = ROOT / "build/reports/e1x_repair_rom_cocotb.json"
BOOT_REPAIR_FW = ROOT / "build/reports/e1x_boot_repair_fw.json"

CASES = {
    "normal": {
        "repair": ROOT / "benchmarks/results/e1x-real-graph-model-load.normal_repair_manifest.json",
        "rom": ROOT / "benchmarks/results/e1x-real-graph-model-load.normal_repair_rom.json",
        "expected_rom_sha256": "7911d1a3f892202baa2f39f6277d7efda42ac1d7a35e37c9bc3b597f8473cd97",
        "expected_window_remap_count": 2,
        "expected_window_remap_words_sha256": "0fe16d68b1eb8fcb455a6e2268390b69e2180b988eda59f98d7d917c0565adf4",
    },
    "high_failure": {
        "repair": ROOT / "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_manifest.json",
        "rom": ROOT / "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_rom.json",
        "expected_rom_sha256": "9f2710a5266260fe9885f22954d14f3e6787840d5c6b0bf36781a051e42e29da",
        "expected_window_remap_count": 24,
        "expected_window_remap_words_sha256": "9c1b36917508a10a43b22210e13945a189a96f1571e4fcee06a92e4fc14af3c4",
    },
}

ROWS_PER_LAYER = 64


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def word_list_sha256(words: list[str]) -> str:
    return sha256(("\n".join(words) + "\n").encode()).hexdigest()


def touched_window_cores(placement: dict) -> list[int]:
    touched: set[int] = set()
    for layer in placement.get("layers", []):
        if not isinstance(layer, dict):
            continue
        window_rows = min(ROWS_PER_LAYER, int(layer.get("rows", 0)))
        covered_rows = 0
        ordinal = 0
        while covered_rows < window_rows:
            row_count = min(int(layer["rows_per_core"]), window_rows - covered_rows)
            touched.add(int(layer["core_index_start"]) + ordinal)
            covered_rows += row_count
            ordinal += 1
    return sorted(touched)


def coord_key(coord: dict) -> tuple[int, int]:
    return int(coord["row"]), int(coord["col"])


def coord_index(coord: tuple[int, int], cols: int) -> int:
    return coord[0] * cols + coord[1]


def u64_hex(value: int) -> str:
    return f"{value & ((1 << 64) - 1):016x}"


def case_window_remap_words(case: str, placement: dict, touched_cores: list[int], paths: dict) -> tuple[list[str], list[str], dict]:
    repair = load_json(paths["repair"])
    rom = load_json(paths["rom"])
    logical_cols = int(repair["logical_cols"])
    physical_cols = int(repair["physical_cols"])
    remap = {
        coord_key(entry["logical"]): coord_key(entry["physical"])
        for entry in repair.get("remapped_cores", [])
    }
    expected_words = []
    sampled_words = []
    for logical_core_index in touched_cores:
        logical = (logical_core_index // int(placement["logical_cols"]), logical_core_index % int(placement["logical_cols"]))
        physical = remap.get(logical)
        if physical is None:
            continue
        word = u64_hex((coord_index(logical, logical_cols) << 32) | coord_index(physical, physical_cols))
        expected_words.append(word)
        if len(sampled_words) < 8:
            sampled_words.append(word)
    header_count = int(rom.get("header_word_count", 0))
    remap_count = int(rom.get("remap_word_count", 0))
    rom_remap_words = list(rom.get("words", []))[header_count : header_count + remap_count]
    summary = {
        "case": case,
        "rom_sha256": str(rom.get("artifact_sha256", "")),
        "source_repair_manifest_sha256": str(rom.get("source_repair_manifest_sha256", "")),
        "rom_total_word_count": int(rom.get("total_word_count", 0)),
        "rom_remap_word_count": remap_count,
        "rom_route_sample_word_count": int(rom.get("route_sample_word_count", 0)),
        "window_remap_word_count": len(expected_words),
        "window_remap_words_sha256": word_list_sha256(expected_words),
        "sampled_window_remap_words": sampled_words,
    }
    missing_words = [word for word in expected_words if word not in set(rom_remap_words)]
    return expected_words, missing_words, summary


def main() -> int:
    checks: list[dict[str, str]] = []
    paths = [PLACEMENT, WINDOW_REPAIR, WINDOW_ROUTE, REPAIR_ROM_COCOTB, BOOT_REPAIR_FW]
    for case_paths in CASES.values():
        paths.extend([case_paths["repair"], case_paths["rom"]])
    missing = [str(path.relative_to(ROOT)) for path in paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "window repair-ROM linkage inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append({"id": "e1x_window_repair_rom_linkage_inputs_present", "status": status, "detail": detail})

    placement = load_json(PLACEMENT) if PLACEMENT.is_file() else {}
    window_repair = load_json(WINDOW_REPAIR) if WINDOW_REPAIR.is_file() else {}
    window_route = load_json(WINDOW_ROUTE) if WINDOW_ROUTE.is_file() else {}
    repair_rom_cocotb = load_json(REPAIR_ROM_COCOTB) if REPAIR_ROM_COCOTB.is_file() else {}
    boot_fw = load_json(BOOT_REPAIR_FW) if BOOT_REPAIR_FW.is_file() else {}
    deps_ok = (
        placement.get("schema") == "eliza.e1x.graph_mesh_placement.v1"
        and window_repair.get("status") == "PASS"
        and int(window_repair.get("summary", {}).get("window_touched_core_count", 0)) == 1_169
        and window_route.get("status") == "PASS"
        and int(window_route.get("summary", {}).get("window_neighbor_edge_count", 0)) == 963
        and repair_rom_cocotb.get("status") == "PASS"
        and int(repair_rom_cocotb.get("summary", {}).get("testcases", 0)) >= 16
        and boot_fw.get("status") == "PASS"
        and int(boot_fw.get("summary", {}).get("verified_rom_case_count", 0)) >= 3
    )
    status, detail = pass_fail(
        deps_ok,
        "window repair/route reports, repair-ROM cocotb, and boot repair firmware are PASS",
        "window repair-ROM dependency report missing, stale, or failing",
    )
    checks.append({"id": "e1x_window_repair_rom_linkage_dependencies_pass", "status": status, "detail": detail})

    touched_cores = touched_window_cores(placement)
    touched_ok = len(touched_cores) == 1_169
    status, detail = pass_fail(
        touched_ok,
        "window touched-core set recovered from placement",
        "window touched-core count mismatch",
    )
    checks.append({"id": "e1x_window_repair_rom_linkage_touched_cores", "status": status, "detail": detail})

    case_summaries: dict[str, dict] = {}
    all_missing_words: list[str] = []
    for case, case_paths in CASES.items():
        _, missing_words, summary = case_window_remap_words(case, placement, touched_cores, case_paths)
        case_summaries[case] = summary
        all_missing_words.extend(f"{case}:{word}" for word in missing_words)
        expected_ok = (
            summary["rom_sha256"] == case_paths["expected_rom_sha256"]
            and int(summary["window_remap_word_count"]) == int(case_paths["expected_window_remap_count"])
            and summary["window_remap_words_sha256"] == case_paths["expected_window_remap_words_sha256"]
            and int(summary["rom_route_sample_word_count"]) == 64
            and not missing_words
        )
        status, detail = pass_fail(
            expected_ok,
            f"{case} repair ROM contains every window-touched remap word",
            f"{case} repair ROM window remap linkage mismatch",
        )
        checks.append({"id": f"e1x_window_repair_rom_linkage_{case}", "status": status, "detail": detail})

    rom_ok = not all_missing_words
    status, detail = pass_fail(
        rom_ok,
        "normal/high repair ROM remap payloads cover all window-touched remapped cores",
        "missing window remap ROM words: " + ", ".join(all_missing_words[:8]),
    )
    checks.append({"id": "e1x_window_repair_rom_linkage_all_window_remaps_programmed", "status": status, "detail": detail})

    failures = [check for check in checks if check["status"] != "pass"]
    normal = case_summaries.get("normal", {})
    high = case_summaries.get("high_failure", {})
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "window_touched_core_count": len(touched_cores),
        "normal_window_remap_word_count": int(normal.get("window_remap_word_count", 0)),
        "high_failure_window_remap_word_count": int(high.get("window_remap_word_count", 0)),
        "normal_window_remap_words_sha256": str(normal.get("window_remap_words_sha256", "")),
        "high_failure_window_remap_words_sha256": str(high.get("window_remap_words_sha256", "")),
        "normal_repair_rom_sha256": str(normal.get("rom_sha256", "")),
        "high_failure_repair_rom_sha256": str(high.get("rom_sha256", "")),
        "normal_rom_total_word_count": int(normal.get("rom_total_word_count", 0)),
        "high_failure_rom_total_word_count": int(high.get("rom_total_word_count", 0)),
        "repair_rom_cocotb_testcases": int(repair_rom_cocotb.get("summary", {}).get("testcases", 0)),
        "boot_verified_rom_case_count": int(boot_fw.get("summary", {}).get("verified_rom_case_count", 0)),
        "window_route_high_failure_checksum": int(
            window_route.get("summary", {}).get("high_failure_window_route_checksum", 0)
        ),
        "case_summaries": case_summaries,
        "residual_blocker": "full_output_vectorized_tensor_fabric_executor_missing",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-window-repair-rom-linkage",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Checks that normal/high repair ROM remap payloads contain the remap "
            "words needed by the executed vector-window touched cores, and links "
            "that payload to RTL repair-ROM cocotb plus boot firmware evidence. "
            "This is programmed repair-image evidence, not silicon fuse/OTP evidence."
        ),
        "evidence_paths": [
            "benchmarks/results/e1x-real-graph-model-load.placement.json",
            "benchmarks/results/e1x-real-graph-model-load.normal_repair_manifest.json",
            "benchmarks/results/e1x-real-graph-model-load.normal_repair_rom.json",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_manifest.json",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_rom.json",
            "build/reports/e1x_window_repair_linkage.json",
            "build/reports/e1x_window_route_validation.json",
            "build/reports/e1x_repair_rom_cocotb.json",
            "build/reports/e1x_boot_repair_fw.json",
            "scripts/check_e1x_window_repair_rom_linkage.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X window repair-ROM linkage failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X window repair-ROM linkage; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
