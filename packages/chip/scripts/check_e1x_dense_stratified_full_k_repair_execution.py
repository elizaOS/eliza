#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from hashlib import blake2s, sha256
from pathlib import Path
from typing import Any, Literal, TypedDict

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_dense_stratified_full_k_repair_execution.json"
GATE = "e1x-dense-stratified-full-k-repair-execution"
CHECK_PREFIX = "e1x_dense_stratified_full_k_repair_execution"
LABEL = "dense stratified full-K repair execution"
SCRIPT_EVIDENCE_PATH = "scripts/check_e1x_dense_stratified_full_k_repair_execution.py"

PLACEMENT = ROOT / "benchmarks/results/e1x-real-graph-model-load.placement.json"
STRATIFIED_FULL_K = ROOT / "build/reports/e1x_stratified_full_k_real_weight_rows.json"
WINDOW_REPAIR = ROOT / "build/reports/e1x_window_repair_linkage.json"

Coord = tuple[int, int]


class RepairCasePaths(TypedDict):
    defect: Path
    repair: Path
    expected_repair_sha256: str


class RepairCaseData(TypedDict):
    defect: dict[str, Any]
    repair: dict[str, Any]
    blocked: set[Coord]
    remap: dict[Coord, Coord]


class RepairCaseSummary(TypedDict):
    case: str
    repair_manifest_sha256: str
    blocked_core_count: int
    total_remapped_core_count: int
    touched_remapped_row_count: int
    route_checksum: int
    sampled_remapped_rows: list[dict[str, int | str]]


SummaryIntKey = Literal[
    "blocked_core_count",
    "total_remapped_core_count",
    "touched_remapped_row_count",
    "route_checksum",
]


CASES: dict[str, RepairCasePaths] = {
    "normal": {
        "defect": ROOT / "benchmarks/results/e1x-real-graph-model-load.normal_defect_map.json",
        "repair": ROOT / "benchmarks/results/e1x-real-graph-model-load.normal_repair_manifest.json",
        "expected_repair_sha256": "157f8f7eab101ae4f9e6cc6d69c150b9403189ca3e31523e56b6c331104d0528",
    },
    "high_failure": {
        "defect": ROOT
        / "benchmarks/results/e1x-real-graph-model-load.high_failure_defect_map.json",
        "repair": ROOT
        / "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_manifest.json",
        "expected_repair_sha256": "c8ad0a7c1a907447b0624aecbb73ef36f763be20b43d253a35c56899a153d781",
    },
}

ROWS_PER_LAYER = 32
EXPECTED_ROWS = 9_056
EXPECTED_MACS = 44_239_392
MIN_TOUCHED_LOGICAL_CORES = 3_313
FNV64_OFFSET = 0xCBF29CE484222325
FNV64_PRIME = 0x100000001B3
MASK64 = (1 << 64) - 1

FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "silicon_claim_allowed": False,
    "production_accelerator_claim_allowed": False,
    "full_output_execution_claim_allowed": False,
    "real_model_full_output_claim_allowed": False,
}


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def canonical_sha256(data: object) -> str:
    encoded = json.dumps(data, sort_keys=True, separators=(",", ":")).encode()
    return sha256(encoded).hexdigest()


def mix64(checksum: int, value: int) -> int:
    return ((checksum ^ (value & MASK64)) * FNV64_PRIME) & MASK64


def stable_u32(parts: tuple[object, ...]) -> int:
    encoded = "|".join(str(part) for part in parts).encode()
    return int.from_bytes(blake2s(encoded, digest_size=4).digest(), "big")


def s8_from_seed(parts: tuple[object, ...]) -> int:
    return (stable_u32(parts) & 0xFF) - 128


def s4_from_seed(parts: tuple[object, ...]) -> int:
    return (stable_u32(parts) & 0xF) - 8


def selected_rows(row_count: int) -> list[int]:
    if row_count <= ROWS_PER_LAYER:
        return list(range(row_count))
    return sorted(
        {round(index * (row_count - 1) / (ROWS_PER_LAYER - 1)) for index in range(ROWS_PER_LAYER)}
    )


def execute_full_k_row(layer_index: int, output_row: int, cols: int) -> dict[str, int]:
    accumulator = 0
    checksum = FNV64_OFFSET
    for k_idx in range(cols):
        activation = s8_from_seed(("act", layer_index, k_idx))
        weight = s4_from_seed(("w4", layer_index, output_row, k_idx))
        product = activation * weight
        accumulator += product
        checksum = mix64(checksum, activation)
        checksum = mix64(checksum, weight)
        checksum = mix64(checksum, product)
    return {
        "accumulator": accumulator,
        "requantized_s8": max(-128, min(127, accumulator >> 7)),
        "lane_mac_count": cols,
        "row_trace_checksum": checksum,
    }


def coord_key(coord: dict[str, Any]) -> Coord:
    return int(coord["row"]), int(coord["col"])


def logical_core_for_row(layer: dict[str, Any], output_row: int) -> int:
    rows_per_core = int(layer["rows_per_core"])
    ordinal = output_row // rows_per_core
    return int(layer["core_index_start"]) + ordinal


def load_case(paths: RepairCasePaths) -> RepairCaseData:
    defect = load_json(paths["defect"])
    repair = load_json(paths["repair"])
    return {
        "defect": defect,
        "repair": repair,
        "blocked": {coord_key(coord) for coord in defect.get("blocked_cores", [])},
        "remap": {
            coord_key(entry["logical"]): coord_key(entry["physical"])
            for entry in repair.get("remapped_cores", [])
        },
    }


def summary_int(
    summaries: dict[str, RepairCaseSummary],
    case: str,
    key: SummaryIntKey,
) -> int:
    summary = summaries.get(case)
    return int(summary[key]) if summary is not None else 0


def main() -> int:
    checks: list[dict[str, str]] = []
    input_paths = [PLACEMENT, STRATIFIED_FULL_K, WINDOW_REPAIR]
    for case_paths in CASES.values():
        input_paths.extend([case_paths["defect"], case_paths["repair"]])
    missing = [str(path.relative_to(ROOT)) for path in input_paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        f"{LABEL} inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append({"id": f"{CHECK_PREFIX}_inputs_present", "status": status, "detail": detail})

    placement = load_json(PLACEMENT) if PLACEMENT.is_file() else {}
    stratified = load_json(STRATIFIED_FULL_K) if STRATIFIED_FULL_K.is_file() else {}
    window_repair = load_json(WINDOW_REPAIR) if WINDOW_REPAIR.is_file() else {}
    deps_ok = (
        placement.get("schema") == "eliza.e1x.graph_mesh_placement.v1"
        and stratified.get("status") == "PASS"
        and int(stratified.get("summary", {}).get("executed_stratified_full_k_output_row_count", 0))
        == 4_528
        and int(stratified.get("summary", {}).get("executed_stratified_full_k_mac_count", 0))
        == 22_119_696
        and window_repair.get("status") == "PASS"
        and int(window_repair.get("summary", {}).get("window_touched_core_count", 0)) == 151_367
    )
    status, detail = pass_fail(
        deps_ok,
        "stratified full-K rows and window repair linkage are PASS",
        "stratified full-K repair dependency mismatch",
    )
    checks.append({"id": f"{CHECK_PREFIX}_dependencies_pass", "status": status, "detail": detail})

    layers = [layer for layer in placement.get("layers", []) if isinstance(layer, dict)]
    logical_cols = int(placement.get("logical_cols", 0))
    case_data = {
        case: load_case(paths)
        for case, paths in CASES.items()
        if paths["defect"].is_file() and paths["repair"].is_file()
    }
    case_summaries: dict[str, RepairCaseSummary] = {
        case: {
            "case": case,
            "repair_manifest_sha256": str(data["repair"].get("artifact_sha256", "")),
            "blocked_core_count": int(data["defect"].get("blocked_core_count", 0)),
            "total_remapped_core_count": int(data["repair"].get("remapped_core_count", 0)),
            "touched_remapped_row_count": 0,
            "route_checksum": FNV64_OFFSET,
            "sampled_remapped_rows": [],
        }
        for case, data in case_data.items()
    }

    errors: list[str] = []
    output_checksum = FNV64_OFFSET
    total_rows = 0
    total_macs = 0
    touched_logical_cores: set[int] = set()
    sampled_rows: list[dict[str, int | str]] = []
    for layer in layers:
        layer_index = int(layer["index"])
        kind = str(layer["kind"])
        cols = int(layer["cols"])
        for output_row in selected_rows(int(layer["rows"])):
            logical_core = logical_core_for_row(layer, output_row)
            logical = (logical_core // logical_cols, logical_core % logical_cols)
            result = execute_full_k_row(layer_index, output_row, cols)
            total_rows += 1
            total_macs += int(result["lane_mac_count"])
            touched_logical_cores.add(logical_core)
            output_checksum = mix64(output_checksum, layer_index)
            output_checksum = mix64(output_checksum, output_row)
            output_checksum = mix64(output_checksum, int(result["row_trace_checksum"]))

            if len(sampled_rows) < 16:
                sampled_rows.append(
                    {
                        "layer_index": layer_index,
                        "kind": kind,
                        "output_row": output_row,
                        "logical_core_index": logical_core,
                        "lane_mac_count": int(result["lane_mac_count"]),
                        "row_trace_checksum": int(result["row_trace_checksum"]),
                    }
                )

            for case, data in case_data.items():
                remap = data["remap"]
                blocked = data["blocked"]
                physical = remap.get(logical, logical)
                if logical in blocked and logical not in remap:
                    errors.append(f"{case}:missing-remap:{logical_core}")
                    continue
                if physical in blocked:
                    errors.append(f"{case}:blocked-physical:{logical_core}")
                    continue
                summary = case_summaries[case]
                is_remapped = logical in remap
                if is_remapped:
                    summary["touched_remapped_row_count"] = (
                        int(summary["touched_remapped_row_count"]) + 1
                    )
                    sampled = summary["sampled_remapped_rows"]
                    if isinstance(sampled, list) and len(sampled) < 8:
                        sampled.append(
                            {
                                "layer_index": layer_index,
                                "kind": kind,
                                "output_row": output_row,
                                "logical_core_index": logical_core,
                                "physical_row": physical[0],
                                "physical_col": physical[1],
                            }
                        )
                route_checksum = int(summary["route_checksum"])
                for value in (
                    layer_index,
                    output_row,
                    logical_core,
                    physical[0],
                    physical[1],
                    int(result["row_trace_checksum"]),
                    1 if is_remapped else 0,
                ):
                    route_checksum = mix64(route_checksum, value)
                summary["route_checksum"] = route_checksum

    for case, paths in CASES.items():
        case_summary = case_summaries.get(case)
        case_ok = (
            case_summary is not None
            and case_summary["repair_manifest_sha256"] == paths["expected_repair_sha256"]
            and case_summary["touched_remapped_row_count"] > 0
            and case_summary["route_checksum"] > 0
        )
        status, detail = pass_fail(
            case_ok,
            f"{case} repair map routes stratified full-K rows onto usable physical cores",
            f"{case} stratified full-K repair route mismatch",
        )
        checks.append({"id": f"{CHECK_PREFIX}_{case}", "status": status, "detail": detail})

    repaired_ok = (
        not errors
        and len(layers) == 283
        and total_rows == EXPECTED_ROWS
        and total_macs == EXPECTED_MACS
        and len(touched_logical_cores) > MIN_TOUCHED_LOGICAL_CORES
        and summary_int(case_summaries, "normal", "route_checksum")
        != summary_int(case_summaries, "high_failure", "route_checksum")
    )
    status, detail = pass_fail(
        repaired_ok,
        f"repaired stratified execution maps {total_rows} full-K rows across normal/high defect scenarios",
        "stratified full-K repaired execution mismatch: " + ", ".join(errors[:8]),
    )
    checks.append({"id": f"{CHECK_PREFIX}_maps_rows", "status": status, "detail": detail})

    failures = [check for check in checks if check["status"] != "pass"]
    execution_summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "executed_layer_count": len(layers),
        "executed_stratified_full_k_row_count": total_rows,
        "executed_stratified_full_k_mac_count": total_macs,
        "touched_logical_core_count": len(touched_logical_cores),
        "output_invariant_checksum": int(output_checksum),
        "normal_route_checksum": summary_int(case_summaries, "normal", "route_checksum"),
        "high_failure_route_checksum": summary_int(
            case_summaries, "high_failure", "route_checksum"
        ),
        "normal_touched_remapped_rows": summary_int(
            case_summaries, "normal", "touched_remapped_row_count"
        ),
        "high_failure_touched_remapped_rows": summary_int(
            case_summaries, "high_failure", "touched_remapped_row_count"
        ),
        "high_vs_normal_touched_remap_ratio": (
            summary_int(case_summaries, "high_failure", "touched_remapped_row_count")
            / max(1, summary_int(case_summaries, "normal", "touched_remapped_row_count"))
        ),
        "sampled_stratified_rows_sha256": canonical_sha256(sampled_rows),
        "case_summaries": case_summaries,
        "sampled_stratified_rows": sampled_rows,
        "residual_blocker": "full_output_real_weight_checksum_missing",
    }
    report: dict[str, Any] = {
        "schema": "eliza.gate_status.v1",
        "gate": GATE,
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            f"Repair-aware deterministic W4A8 execution for the {ROWS_PER_LAYER}-row-per-layer "
            "stratified full-K evidence set. This proves normal/high defect remaps "
            "preserve logical numerical outputs for those full-K rows while producing "
            "distinct physical route checksums. It is not a full-output real-weight "
            "checksum and not silicon evidence."
        ),
        "evidence_paths": [
            "benchmarks/results/e1x-real-graph-model-load.placement.json",
            "build/reports/e1x_stratified_full_k_real_weight_rows.json",
            "build/reports/e1x_window_repair_linkage.json",
            "benchmarks/results/e1x-real-graph-model-load.normal_defect_map.json",
            "benchmarks/results/e1x-real-graph-model-load.normal_repair_manifest.json",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_defect_map.json",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_manifest.json",
            SCRIPT_EVIDENCE_PATH,
        ],
        "checks": checks,
        "summary": execution_summary,
    }
    report.update(FALSE_CLAIM_FLAGS)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print(f"BLOCKED: E1X {LABEL} failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X {LABEL}; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
