#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from hashlib import sha256
from math import ceil
from pathlib import Path
from typing import TypedDict


class CaseSpec(TypedDict):
    repair: Path
    rom: Path
    expected_rom_sha256: str
    expected_payload_remap_words: int


class CaseSummary(TypedDict):
    rom_sha256: str
    source_repair_manifest_sha256: str
    rom_total_word_count: int
    rom_remap_word_count: int
    rom_route_sample_word_count: int
    payload_remap_word_count: int
    payload_remap_words_sha256: str
    payload_remap_program_checksum: int
    sampled_payload_remap_records: list[dict[str, int | str]]


ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_full_payload_repair_rom.json"

PLACEMENT = ROOT / "benchmarks/results/e1x-real-graph-model-load.placement.json"
FULL_PAYLOAD_REPAIR = ROOT / "build/reports/e1x_full_payload_repair_mapping.json"
WINDOW_REPAIR_ROM = ROOT / "build/reports/e1x_window_repair_rom_linkage.json"
REPAIR_ROM_COCOTB = ROOT / "build/reports/e1x_repair_rom_cocotb.json"
BOOT_REPAIR_FW = ROOT / "build/reports/e1x_boot_repair_fw.json"

CASES: dict[str, CaseSpec] = {
    "normal": {
        "repair": ROOT / "benchmarks/results/e1x-real-graph-model-load.normal_repair_manifest.json",
        "rom": ROOT / "benchmarks/results/e1x-real-graph-model-load.normal_repair_rom.json",
        "expected_rom_sha256": "7911d1a3f892202baa2f39f6277d7efda42ac1d7a35e37c9bc3b597f8473cd97",
        "expected_payload_remap_words": 279,
    },
    "high_failure": {
        "repair": ROOT
        / "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_manifest.json",
        "rom": ROOT / "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_rom.json",
        "expected_rom_sha256": "9f2710a5266260fe9885f22954d14f3e6787840d5c6b0bf36781a051e42e29da",
        "expected_payload_remap_words": 3_012,
    },
}

WORD_BYTES = 4
MASK64 = (1 << 64) - 1
FNV64_OFFSET = 0xCBF29CE484222325
FNV64_PRIME = 0x100000001B3


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def word_list_sha256(words: list[str]) -> str:
    return sha256(("\n".join(words) + "\n").encode()).hexdigest()


def canonical_sha256(data: object) -> str:
    encoded = json.dumps(data, sort_keys=True, separators=(",", ":")).encode()
    return sha256(encoded).hexdigest()


def mix64(checksum: int, value: int) -> int:
    return ((checksum ^ (value & MASK64)) * FNV64_PRIME) & MASK64


def coord_key(coord: dict) -> tuple[int, int]:
    return int(coord["row"]), int(coord["col"])


def coord_index(coord: tuple[int, int], cols: int) -> int:
    return coord[0] * cols + coord[1]


def u64_hex(value: int) -> str:
    return f"{value & MASK64:016x}"


def placement_records(placement: dict) -> list[dict[str, int | str]]:
    records: list[dict[str, int | str]] = []
    for layer in placement.get("layers", []):
        if not isinstance(layer, dict):
            continue
        rows = int(layer["rows"])
        cols = int(layer["cols"])
        weight_bits = int(layer["weight_bits"])
        rows_per_core = int(layer["rows_per_core"])
        assigned_cores = int(layer["assigned_cores"])
        bytes_per_row = ceil(cols * weight_bits / 8)
        for ordinal in range(assigned_cores):
            row_start = ordinal * rows_per_core
            if row_start >= rows:
                break
            row_count = min(rows_per_core, rows - row_start)
            shard_bytes = row_count * bytes_per_row
            records.append(
                {
                    "layer_index": int(layer["index"]),
                    "kind": str(layer["kind"]),
                    "logical_core_index": int(layer["core_index_start"]) + ordinal,
                    "loader_words": ceil(shard_bytes / WORD_BYTES),
                    "shard_bytes": shard_bytes,
                }
            )
    return records


def case_payload_remap_words(
    placement: dict,
    records: list[dict[str, int | str]],
    paths: CaseSpec,
) -> tuple[list[str], list[str], CaseSummary]:
    repair = load_json(paths["repair"])
    rom = load_json(paths["rom"])
    logical_cols = int(repair["logical_cols"])
    physical_cols = int(repair["physical_cols"])
    placement_logical_cols = int(placement["logical_cols"])
    remap = {
        coord_key(entry["logical"]): coord_key(entry["physical"])
        for entry in repair.get("remapped_cores", [])
    }
    expected_words: list[str] = []
    sampled_records: list[dict[str, int | str]] = []
    checksum = FNV64_OFFSET
    for record in records:
        logical_core_index = int(record["logical_core_index"])
        logical = (
            logical_core_index // placement_logical_cols,
            logical_core_index % placement_logical_cols,
        )
        physical = remap.get(logical)
        if physical is None:
            continue
        word = u64_hex(
            (coord_index(logical, logical_cols) << 32) | coord_index(physical, physical_cols)
        )
        expected_words.append(word)
        for value in (
            int(record["layer_index"]),
            logical_core_index,
            int(word, 16),
            int(record["loader_words"]),
        ):
            checksum = mix64(checksum, value)
        if len(sampled_records) < 8:
            sampled_records.append(
                {
                    "layer_index": int(record["layer_index"]),
                    "kind": str(record["kind"]),
                    "logical_core_index": logical_core_index,
                    "rom_word": word,
                }
            )
    header_count = int(rom.get("header_word_count", 0))
    remap_count = int(rom.get("remap_word_count", 0))
    rom_remap_words = list(rom.get("words", []))[header_count : header_count + remap_count]
    rom_word_set = set(rom_remap_words)
    missing_words = [word for word in expected_words if word not in rom_word_set]
    summary: CaseSummary = {
        "rom_sha256": str(rom.get("artifact_sha256", "")),
        "source_repair_manifest_sha256": str(rom.get("source_repair_manifest_sha256", "")),
        "rom_total_word_count": int(rom.get("total_word_count", 0)),
        "rom_remap_word_count": remap_count,
        "rom_route_sample_word_count": int(rom.get("route_sample_word_count", 0)),
        "payload_remap_word_count": len(expected_words),
        "payload_remap_words_sha256": word_list_sha256(expected_words),
        "payload_remap_program_checksum": checksum,
        "sampled_payload_remap_records": sampled_records,
    }
    return expected_words, missing_words, summary


def main() -> int:
    checks: list[dict[str, str]] = []
    input_paths = [
        PLACEMENT,
        FULL_PAYLOAD_REPAIR,
        WINDOW_REPAIR_ROM,
        REPAIR_ROM_COCOTB,
        BOOT_REPAIR_FW,
    ]
    for paths in CASES.values():
        input_paths.extend([paths["repair"], paths["rom"]])
    missing = [str(path.relative_to(ROOT)) for path in input_paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "full-payload repair-ROM inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append(
        {"id": "e1x_full_payload_repair_rom_inputs_present", "status": status, "detail": detail}
    )

    placement = load_json(PLACEMENT) if PLACEMENT.is_file() else {}
    full_payload_repair = load_json(FULL_PAYLOAD_REPAIR) if FULL_PAYLOAD_REPAIR.is_file() else {}
    window_repair_rom = load_json(WINDOW_REPAIR_ROM) if WINDOW_REPAIR_ROM.is_file() else {}
    repair_rom_cocotb = load_json(REPAIR_ROM_COCOTB) if REPAIR_ROM_COCOTB.is_file() else {}
    boot_fw = load_json(BOOT_REPAIR_FW) if BOOT_REPAIR_FW.is_file() else {}

    deps_ok = (
        placement.get("schema") == "eliza.e1x.graph_mesh_placement.v1"
        and full_payload_repair.get("status") == "PASS"
        and int(full_payload_repair.get("summary", {}).get("payload_shard_record_count", 0))
        == 151_367
        and window_repair_rom.get("status") == "PASS"
        and int(window_repair_rom.get("summary", {}).get("window_touched_core_count", 0)) == 151_367
        and repair_rom_cocotb.get("status") == "PASS"
        and int(repair_rom_cocotb.get("summary", {}).get("testcases", 0)) >= 16
        and boot_fw.get("status") == "PASS"
        and int(boot_fw.get("summary", {}).get("verified_rom_case_count", 0)) >= 3
    )
    status, detail = pass_fail(
        deps_ok,
        "full-payload repair mapping, window repair-ROM linkage, RTL cocotb, and boot firmware are PASS",
        "dependency report missing, stale, or failing",
    )
    checks.append(
        {"id": "e1x_full_payload_repair_rom_dependencies_pass", "status": status, "detail": detail}
    )

    records = placement_records(placement)
    records_ok = (
        len(records) == 151_367
        and sum(int(record["loader_words"]) for record in records) == 1_627_034_880
        and sum(int(record["shard_bytes"]) for record in records) == 6_508_139_520
    )
    status, detail = pass_fail(
        records_ok,
        "full-payload repair-ROM gate reconstructs every resident shard record",
        "full-payload shard record reconstruction mismatch",
    )
    checks.append(
        {
            "id": "e1x_full_payload_repair_rom_records_reconstructed",
            "status": status,
            "detail": detail,
        }
    )

    case_summaries: dict[str, CaseSummary] = {}
    all_missing_words: list[str] = []
    for case, paths in CASES.items():
        _, missing_words, summary = case_payload_remap_words(placement, records, paths)
        case_summaries[case] = summary
        all_missing_words.extend(f"{case}:{word}" for word in missing_words)
        case_ok = (
            not missing_words
            and summary["rom_sha256"] == paths["expected_rom_sha256"]
            and int(summary["payload_remap_word_count"])
            == int(paths["expected_payload_remap_words"])
            and int(summary["rom_route_sample_word_count"]) == 64
            and int(summary["payload_remap_program_checksum"]) > 0
        )
        status, detail = pass_fail(
            case_ok,
            f"{case} repair ROM contains every full-payload remap word needed by resident shards",
            f"{case} full-payload repair-ROM remap coverage mismatch",
        )
        checks.append(
            {"id": f"e1x_full_payload_repair_rom_{case}", "status": status, "detail": detail}
        )

    rtl_boot_ok = (
        int(repair_rom_cocotb.get("summary", {}).get("testcases", 0)) >= 16
        and int(boot_fw.get("summary", {}).get("verified_rom_case_count", 0)) == 3
        and int(boot_fw.get("summary", {}).get("max_rom_word_count", 0)) >= 3_582
    )
    status, detail = pass_fail(
        rtl_boot_ok,
        "full-payload repair ROMs are linked to RTL ROM-loader cocotb and boot repair firmware evidence",
        "full-payload repair ROM RTL/boot linkage mismatch",
    )
    checks.append(
        {"id": "e1x_full_payload_repair_rom_rtl_boot_linked", "status": status, "detail": detail}
    )

    failures = [check for check in checks if check["status"] != "pass"]
    _empty_summary: CaseSummary = {
        "rom_sha256": "",
        "source_repair_manifest_sha256": "",
        "rom_total_word_count": 0,
        "rom_remap_word_count": 0,
        "rom_route_sample_word_count": 0,
        "payload_remap_word_count": 0,
        "payload_remap_words_sha256": "",
        "payload_remap_program_checksum": 0,
        "sampled_payload_remap_records": [],
    }
    normal: CaseSummary = case_summaries.get("normal", _empty_summary)
    high: CaseSummary = case_summaries.get("high_failure", _empty_summary)
    combined_checksum = FNV64_OFFSET
    for value in (
        int(full_payload_repair.get("summary", {}).get("combined_payload_repair_checksum", 0)),
        normal["payload_remap_program_checksum"],
        high["payload_remap_program_checksum"],
        int(repair_rom_cocotb.get("summary", {}).get("testcases", 0)),
        int(boot_fw.get("summary", {}).get("verified_rom_case_count", 0)),
    ):
        combined_checksum = mix64(combined_checksum, value)
    gate_summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "payload_shard_record_count": len(records),
        "payload_loader_word_count": sum(int(record["loader_words"]) for record in records),
        "normal_payload_remap_word_count": normal["payload_remap_word_count"],
        "high_failure_payload_remap_word_count": high["payload_remap_word_count"],
        "normal_payload_remap_words_sha256": normal["payload_remap_words_sha256"],
        "high_failure_payload_remap_words_sha256": high["payload_remap_words_sha256"],
        "normal_payload_remap_program_checksum": normal["payload_remap_program_checksum"],
        "high_failure_payload_remap_program_checksum": high["payload_remap_program_checksum"],
        "normal_repair_rom_sha256": normal["rom_sha256"],
        "high_failure_repair_rom_sha256": high["rom_sha256"],
        "normal_rom_total_word_count": normal["rom_total_word_count"],
        "high_failure_rom_total_word_count": high["rom_total_word_count"],
        "repair_rom_cocotb_testcases": int(
            repair_rom_cocotb.get("summary", {}).get("testcases", 0)
        ),
        "boot_verified_rom_case_count": int(
            boot_fw.get("summary", {}).get("verified_rom_case_count", 0)
        ),
        "combined_payload_repair_rom_checksum": combined_checksum,
        "case_summary_sha256": canonical_sha256(case_summaries),
        "case_summaries": case_summaries,
        "residual_blocker": "silicon_fuse_burning_and_foundry_otp_macro_missing",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-full-payload-repair-rom",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "false_claim_flags": {
            "claim_allowed": False,
            "release_claim_allowed": False,
            "production_claim_allowed": False,
            "silicon_claim_allowed": False,
            "tapeout_claim_allowed": False,
            "phone_class_claim_allowed": False,
            "fuse_otp_claim_allowed": False,
            "foundry_claim_allowed": False,
        },
        "claim_boundary": (
            "Checks that the normal and high-failure boot-programmable repair ROMs contain "
            "the remap words required by every committed resident payload shard, and links "
            "those ROMs to RTL repair-ROM loader cocotb plus boot firmware evidence. This is "
            "programmed repair-image evidence, not silicon fuse/OTP or foundry evidence."
        ),
        "evidence_paths": [
            "benchmarks/results/e1x-real-graph-model-load.placement.json",
            "benchmarks/results/e1x-real-graph-model-load.normal_repair_manifest.json",
            "benchmarks/results/e1x-real-graph-model-load.normal_repair_rom.json",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_manifest.json",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_rom.json",
            "build/reports/e1x_full_payload_repair_mapping.json",
            "build/reports/e1x_window_repair_rom_linkage.json",
            "build/reports/e1x_repair_rom_cocotb.json",
            "build/reports/e1x_boot_repair_fw.json",
            "scripts/check_e1x_full_payload_repair_rom.py",
        ],
        "checks": checks,
        "summary": gate_summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print(
            "BLOCKED: E1X full-payload repair ROM failed: " + ", ".join(c["id"] for c in failures)
        )
        return 1
    print(f"PASS: E1X full-payload repair ROM; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
