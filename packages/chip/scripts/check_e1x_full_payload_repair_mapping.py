#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from hashlib import sha256
from math import ceil
from pathlib import Path
from typing import cast

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_full_payload_repair_mapping.json"

PLACEMENT = ROOT / "benchmarks/results/e1x-real-graph-model-load.placement.json"
FULL_PAYLOAD = ROOT / "build/reports/e1x_full_payload_manifest.json"
WINDOW_REPAIR = ROOT / "build/reports/e1x_window_repair_linkage.json"
WINDOW_ROUTE = ROOT / "build/reports/e1x_window_route_validation.json"

CASES = {
    "normal": {
        "defect": ROOT / "benchmarks/results/e1x-real-graph-model-load.normal_defect_map.json",
        "repair": ROOT / "benchmarks/results/e1x-real-graph-model-load.normal_repair_manifest.json",
        "expected_repair_sha256": "157f8f7eab101ae4f9e6cc6d69c150b9403189ca3e31523e56b6c331104d0528",
        "expected_payload_remapped_records": 279,
    },
    "high_failure": {
        "defect": ROOT
        / "benchmarks/results/e1x-real-graph-model-load.high_failure_defect_map.json",
        "repair": ROOT
        / "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_manifest.json",
        "expected_repair_sha256": "c8ad0a7c1a907447b0624aecbb73ef36f763be20b43d253a35c56899a153d781",
        "expected_payload_remapped_records": 3_012,
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


def canonical_sha256(data: object) -> str:
    encoded = json.dumps(data, sort_keys=True, separators=(",", ":")).encode()
    return sha256(encoded).hexdigest()


def mix64(checksum: int, value: int) -> int:
    return ((checksum ^ (value & MASK64)) * FNV64_PRIME) & MASK64


def coord_key(coord: dict) -> tuple[int, int]:
    return int(coord["row"]), int(coord["col"])


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
                    "layer_name": str(layer["name"]),
                    "kind": str(layer["kind"]),
                    "logical_core_index": int(layer["core_index_start"]) + ordinal,
                    "row_start": row_start,
                    "row_count": row_count,
                    "loader_words": ceil(shard_bytes / WORD_BYTES),
                    "shard_bytes": shard_bytes,
                }
            )
    return records


def validate_case(
    case: str,
    paths: dict,
    placement: dict,
    records: list[dict[str, int | str]],
) -> tuple[list[str], dict[str, object]]:
    defect = load_json(paths["defect"])
    repair = load_json(paths["repair"])
    logical_cols = int(placement.get("logical_cols", 0))
    blocked = {coord_key(coord) for coord in defect.get("blocked_cores", [])}
    remap = {
        coord_key(entry["logical"]): coord_key(entry["physical"])
        for entry in repair.get("remapped_cores", [])
    }
    errors: list[str] = []
    direct_records = 0
    remapped_records = 0
    physical_targets: set[tuple[int, int]] = set()
    mapping_checksum = FNV64_OFFSET
    sampled_remaps: list[dict[str, int | str]] = []

    for record in records:
        logical_core_index = int(record["logical_core_index"])
        logical = (logical_core_index // logical_cols, logical_core_index % logical_cols)
        physical = remap.get(logical, logical)
        physical_targets.add(physical)
        is_remapped = logical in remap
        if logical in blocked and not is_remapped:
            errors.append(f"missing-remap:{logical_core_index}")
            continue
        if physical in blocked:
            errors.append(f"blocked-physical:{logical_core_index}")
            continue
        if is_remapped:
            remapped_records += 1
            if len(sampled_remaps) < 8:
                sampled_remaps.append(
                    {
                        "layer_index": int(record["layer_index"]),
                        "kind": str(record["kind"]),
                        "logical_core_index": logical_core_index,
                        "logical_row": logical[0],
                        "logical_col": logical[1],
                        "physical_row": physical[0],
                        "physical_col": physical[1],
                    }
                )
        else:
            direct_records += 1
        for value in (
            int(record["layer_index"]),
            logical_core_index,
            logical[0],
            logical[1],
            physical[0],
            physical[1],
            int(record["loader_words"]),
            int(record["shard_bytes"]),
            1 if is_remapped else 0,
        ):
            mapping_checksum = mix64(mapping_checksum, value)

    summary: dict[str, object] = {
        "case": case,
        "defect_map_sha256": str(defect.get("artifact_sha256", "")),
        "repair_manifest_sha256": str(repair.get("artifact_sha256", "")),
        "total_blocked_core_count": int(defect.get("blocked_core_count", 0)),
        "total_remapped_core_count": int(repair.get("remapped_core_count", 0)),
        "payload_shard_record_count": len(records),
        "payload_direct_record_count": direct_records,
        "payload_remapped_record_count": remapped_records,
        "payload_unique_physical_core_count": len(physical_targets),
        "payload_mapping_checksum": mapping_checksum,
        "sampled_payload_remaps": sampled_remaps,
    }
    return errors, summary


def main() -> int:
    checks: list[dict[str, str]] = []
    input_paths = [PLACEMENT, FULL_PAYLOAD, WINDOW_REPAIR, WINDOW_ROUTE]
    for paths in CASES.values():
        input_paths.extend([cast(Path, paths["defect"]), cast(Path, paths["repair"])])
    missing = [str(path.relative_to(ROOT)) for path in input_paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "full-payload repair mapping inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append(
        {"id": "e1x_full_payload_repair_mapping_inputs_present", "status": status, "detail": detail}
    )

    placement = load_json(PLACEMENT) if PLACEMENT.is_file() else {}
    full_payload = load_json(FULL_PAYLOAD) if FULL_PAYLOAD.is_file() else {}
    window_repair = load_json(WINDOW_REPAIR) if WINDOW_REPAIR.is_file() else {}
    window_route = load_json(WINDOW_ROUTE) if WINDOW_ROUTE.is_file() else {}

    deps_ok = (
        placement.get("schema") == "eliza.e1x.graph_mesh_placement.v1"
        and full_payload.get("status") == "PASS"
        and int(full_payload.get("summary", {}).get("committed_shard_record_count", 0)) == 151_367
        and window_repair.get("status") == "PASS"
        and int(window_repair.get("summary", {}).get("window_touched_core_count", 0)) == 151_367
        and window_route.get("status") == "PASS"
        and int(window_route.get("summary", {}).get("window_neighbor_edge_count", 0)) == 301_949
    )
    status, detail = pass_fail(
        deps_ok,
        "placement, full-payload manifest, window repair, and window route reports are PASS",
        "dependency report missing, stale, or failing",
    )
    checks.append(
        {
            "id": "e1x_full_payload_repair_mapping_dependencies_pass",
            "status": status,
            "detail": detail,
        }
    )

    records = placement_records(placement)
    records_ok = (
        len(records) == 151_367
        and len({int(record["logical_core_index"]) for record in records}) == 151_367
        and sum(int(record["loader_words"]) for record in records) == 1_627_034_880
        and sum(int(record["shard_bytes"]) for record in records) == 6_508_139_520
    )
    status, detail = pass_fail(
        records_ok,
        "full payload repair mapping enumerates every placed shard record",
        "placed shard record reconstruction mismatch",
    )
    checks.append(
        {
            "id": "e1x_full_payload_repair_mapping_records_reconstructed",
            "status": status,
            "detail": detail,
        }
    )

    case_summaries: dict[str, dict[str, object]] = {}
    all_errors: list[str] = []
    for case, paths in CASES.items():
        errors, summary = validate_case(case, paths, placement, records)
        case_summaries[case] = summary
        all_errors.extend(f"{case}:{error}" for error in errors)
        case_ok = (
            not errors
            and summary["repair_manifest_sha256"] == paths["expected_repair_sha256"]
            and cast(int, summary["payload_remapped_record_count"])
            == cast(int, paths["expected_payload_remapped_records"])
            and cast(int, summary["payload_direct_record_count"])
            == len(records) - cast(int, summary["payload_remapped_record_count"])
            and cast(int, summary["payload_unique_physical_core_count"]) == len(records)
            and cast(int, summary["payload_mapping_checksum"]) > 0
        )
        status, detail = pass_fail(
            case_ok,
            f"{case} repair manifest maps all payload shards to usable physical cores",
            f"{case} full-payload repair mapping mismatch",
        )
        checks.append(
            {"id": f"e1x_full_payload_repair_mapping_{case}", "status": status, "detail": detail}
        )

    route_boundary_ok = (
        not all_errors
        and int(window_route.get("summary", {}).get("normal_window_route_checksum", 0))
        == 3_286_450_877_122_388_120
        and int(window_route.get("summary", {}).get("high_failure_window_route_checksum", 0))
        == 8_141_847_437_961_269_241
    )
    status, detail = pass_fail(
        route_boundary_ok,
        "full-payload repair mapping inherits validated normal/high repaired route checksums",
        "full-payload repair route linkage mismatch: " + ", ".join(all_errors[:8]),
    )
    checks.append(
        {"id": "e1x_full_payload_repair_mapping_route_boundary", "status": status, "detail": detail}
    )

    failures = [check for check in checks if check["status"] != "pass"]
    normal = case_summaries.get("normal", {})
    high = case_summaries.get("high_failure", {})
    combined_checksum = FNV64_OFFSET
    for value in (
        cast(int, full_payload.get("summary", {}).get("payload_manifest_checksum", 0)),
        cast(int, normal.get("payload_mapping_checksum", 0)),
        cast(int, high.get("payload_mapping_checksum", 0)),
        cast(int, window_route.get("summary", {}).get("normal_window_route_checksum", 0)),
        cast(int, window_route.get("summary", {}).get("high_failure_window_route_checksum", 0)),
    ):
        combined_checksum = mix64(combined_checksum, value)
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "payload_shard_record_count": len(records),
        "payload_loader_word_count": sum(int(record["loader_words"]) for record in records),
        "payload_stream_bytes": sum(int(record["shard_bytes"]) for record in records),
        "payload_manifest_checksum": cast(
            int, full_payload.get("summary", {}).get("payload_manifest_checksum", 0)
        ),
        "normal_payload_remapped_records": cast(int, normal.get("payload_remapped_record_count", 0)),
        "high_failure_payload_remapped_records": cast(int, high.get("payload_remapped_record_count", 0)),
        "normal_payload_direct_records": cast(int, normal.get("payload_direct_record_count", 0)),
        "high_failure_payload_direct_records": cast(int, high.get("payload_direct_record_count", 0)),
        "normal_payload_mapping_checksum": cast(int, normal.get("payload_mapping_checksum", 0)),
        "high_failure_payload_mapping_checksum": cast(int, high.get("payload_mapping_checksum", 0)),
        "high_vs_normal_payload_remap_ratio": (
            cast(int, high.get("payload_remapped_record_count", 0))
            / max(1, cast(int, normal.get("payload_remapped_record_count", 0)))
        ),
        "normal_route_checksum": cast(
            int, window_route.get("summary", {}).get("normal_window_route_checksum", 0)
        ),
        "high_failure_route_checksum": cast(
            int, window_route.get("summary", {}).get("high_failure_window_route_checksum", 0)
        ),
        "combined_payload_repair_checksum": combined_checksum,
        "case_summary_sha256": canonical_sha256(case_summaries),
        "case_summaries": case_summaries,
        "residual_blocker": "full_quantized_weight_payload_executor_missing",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-full-payload-repair-mapping",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Maps every committed real-graph payload shard record through the normal "
            "and high-failure repair manifests and verifies the resulting physical "
            "targets avoid blocked cores. This proves full payload placement survives "
            "the modeled repair maps; it is not wafer-sort, package, or silicon evidence "
            "and does not execute every payload word."
        ),
        "evidence_paths": [
            "benchmarks/results/e1x-real-graph-model-load.placement.json",
            "benchmarks/results/e1x-real-graph-model-load.normal_defect_map.json",
            "benchmarks/results/e1x-real-graph-model-load.normal_repair_manifest.json",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_defect_map.json",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_manifest.json",
            "build/reports/e1x_full_payload_manifest.json",
            "build/reports/e1x_window_repair_linkage.json",
            "build/reports/e1x_window_route_validation.json",
            "scripts/check_e1x_full_payload_repair_mapping.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print(
            "BLOCKED: E1X full-payload repair mapping failed: "
            + ", ".join(c["id"] for c in failures)
        )
        return 1
    print(f"PASS: E1X full-payload repair mapping; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
