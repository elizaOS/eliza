#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_full_k_repair_route_cost.json"

PLACEMENT = ROOT / "benchmarks/results/e1x-real-graph-model-load.placement.json"
KIND_COVERAGE = ROOT / "build/reports/e1x_full_k_repair_kind_coverage.json"
NORMAL_REPAIR = ROOT / "benchmarks/results/e1x-real-graph-model-load.normal_repair_manifest.json"
HIGH_FAILURE_REPAIR = (
    ROOT / "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_manifest.json"
)
RUNG_REPORTS = [
    ("stratified_16", 16, ROOT / "build/reports/e1x_stratified_full_k_repair_execution.json"),
    ("dense_32", 32, ROOT / "build/reports/e1x_dense_stratified_full_k_repair_execution.json"),
    (
        "ultra_dense_64",
        64,
        ROOT / "build/reports/e1x_ultra_dense_stratified_full_k_repair_execution.json",
    ),
    (
        "hyper_dense_128",
        128,
        ROOT / "build/reports/e1x_hyper_dense_stratified_full_k_repair_execution.json",
    ),
]
EXPECTED_REPAIR_SHA256 = {
    "normal": "157f8f7eab101ae4f9e6cc6d69c150b9403189ca3e31523e56b6c331104d0528",
    "high_failure": "c8ad0a7c1a907447b0624aecbb73ef36f763be20b43d253a35c56899a153d781",
}
FNV64_OFFSET = 0xCBF29CE484222325
FNV64_PRIME = 0x100000001B3
MASK64 = (1 << 64) - 1
FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "silicon_claim_allowed": False,
    "production_accelerator_claim_allowed": False,
    "full_output_execution_claim_allowed": False,
    "physical_routing_signoff_claim_allowed": False,
    "real_model_full_output_claim_allowed": False,
}


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


def selected_rows(row_count: int, rows_per_layer: int) -> list[int]:
    if row_count <= rows_per_layer:
        return list(range(row_count))
    return sorted(
        {round(index * (row_count - 1) / (rows_per_layer - 1)) for index in range(rows_per_layer)}
    )


def coord_key(coord: dict) -> tuple[int, int]:
    return int(coord["row"]), int(coord["col"])


def logical_core_for_row(layer: dict, output_row: int) -> int:
    return int(layer["core_index_start"]) + (output_row // int(layer["rows_per_core"]))


def load_remap(path: Path) -> tuple[dict, dict[tuple[int, int], tuple[int, int]]]:
    report = load_json(path)
    remap = {
        coord_key(entry["logical"]): coord_key(entry["physical"])
        for entry in report.get("remapped_cores", [])
    }
    return report, remap


def add_count(target: dict[str, int], key: str, value: int = 1) -> None:
    target[key] = target.get(key, 0) + value


def analyze_case(
    layers: list[dict],
    logical_cols: int,
    rows_per_layer: int,
    remap: dict[tuple[int, int], tuple[int, int]],
) -> dict:
    remapped_rows = 0
    total_distance = 0
    max_distance = 0
    route_cost_checksum = FNV64_OFFSET
    kind_remapped_rows: dict[str, int] = {}
    kind_total_distance: dict[str, int] = {}
    sampled_remaps: list[dict[str, int | str]] = []
    for layer in layers:
        kind = str(layer["kind"])
        layer_index = int(layer["index"])
        for output_row in selected_rows(int(layer["rows"]), rows_per_layer):
            logical_core = logical_core_for_row(layer, output_row)
            logical = (logical_core // logical_cols, logical_core % logical_cols)
            physical = remap.get(logical)
            if physical is None:
                continue
            distance = abs(physical[0] - logical[0]) + abs(physical[1] - logical[1])
            remapped_rows += 1
            total_distance += distance
            max_distance = max(max_distance, distance)
            add_count(kind_remapped_rows, kind)
            add_count(kind_total_distance, kind, distance)
            for value in (
                layer_index,
                output_row,
                logical_core,
                logical[0],
                logical[1],
                physical[0],
                physical[1],
                distance,
            ):
                route_cost_checksum = mix64(route_cost_checksum, value)
            if len(sampled_remaps) < 12:
                sampled_remaps.append(
                    {
                        "layer_index": layer_index,
                        "kind": kind,
                        "output_row": output_row,
                        "logical_core_index": logical_core,
                        "logical_row": logical[0],
                        "logical_col": logical[1],
                        "physical_row": physical[0],
                        "physical_col": physical[1],
                        "manhattan_distance": distance,
                    }
                )
    return {
        "remapped_row_count": remapped_rows,
        "total_remap_manhattan_distance": total_distance,
        "max_remap_manhattan_distance": max_distance,
        "average_remap_manhattan_distance": total_distance / remapped_rows
        if remapped_rows
        else 0.0,
        "kind_remapped_rows": dict(sorted(kind_remapped_rows.items())),
        "kind_total_remap_manhattan_distance": dict(sorted(kind_total_distance.items())),
        "route_cost_checksum": route_cost_checksum,
        "sampled_remaps": sampled_remaps,
    }


def main() -> int:
    checks: list[dict[str, str]] = []
    paths = [PLACEMENT, KIND_COVERAGE, NORMAL_REPAIR, HIGH_FAILURE_REPAIR] + [
        path for _, _, path in RUNG_REPORTS
    ]
    missing = [str(path.relative_to(ROOT)) for path in paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "full-K repair route-cost inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append({"id": "e1x_full_k_repair_route_cost_inputs_present", "status": status, "detail": detail})

    placement = load_json(PLACEMENT) if PLACEMENT.is_file() else {}
    kind_coverage = load_json(KIND_COVERAGE) if KIND_COVERAGE.is_file() else {}
    normal_report, normal_remap = load_remap(NORMAL_REPAIR) if NORMAL_REPAIR.is_file() else ({}, {})
    high_report, high_remap = (
        load_remap(HIGH_FAILURE_REPAIR) if HIGH_FAILURE_REPAIR.is_file() else ({}, {})
    )
    layers = [layer for layer in placement.get("layers", []) if isinstance(layer, dict)]
    logical_cols = int(placement.get("logical_cols", 0))
    deps_ok = (
        placement.get("schema") == "eliza.e1x.graph_mesh_placement.v1"
        and len(layers) == 283
        and kind_coverage.get("status") == "PASS"
        and int(kind_coverage.get("summary", {}).get("kind_count", 0)) == 8
        and normal_report.get("artifact_sha256") == EXPECTED_REPAIR_SHA256["normal"]
        and high_report.get("artifact_sha256") == EXPECTED_REPAIR_SHA256["high_failure"]
    )
    status, detail = pass_fail(
        deps_ok,
        "placement, kind coverage, and normal/high repair manifests are linked",
        "full-K repair route-cost dependency mismatch",
    )
    checks.append({"id": "e1x_full_k_repair_route_cost_dependencies_pass", "status": status, "detail": detail})

    rungs = []
    for name, rows_per_layer, path in RUNG_REPORTS:
        report = load_json(path) if path.is_file() else {}
        summary = report.get("summary", {})
        normal = analyze_case(layers, logical_cols, rows_per_layer, normal_remap)
        high_failure = analyze_case(layers, logical_cols, rows_per_layer, high_remap)
        rung = {
            "name": name,
            "rows_per_layer": rows_per_layer,
            "normal": normal,
            "high_failure": high_failure,
        }
        rungs.append(rung)
        rung_ok = (
            report.get("status") == "PASS"
            and int(summary.get("normal_touched_remapped_rows", 0))
            == int(normal["remapped_row_count"])
            and int(summary.get("high_failure_touched_remapped_rows", 0))
            == int(high_failure["remapped_row_count"])
            and int(high_failure["remapped_row_count"]) > int(normal["remapped_row_count"])
            and int(high_failure["total_remap_manhattan_distance"])
            > int(normal["total_remap_manhattan_distance"])
        )
        status, detail = pass_fail(
            rung_ok,
            f"{name} normal/high remap distances match executed repair row counts",
            f"{name} route-cost totals mismatch",
        )
        checks.append({"id": f"e1x_full_k_repair_route_cost_{name}", "status": status, "detail": detail})

    monotonic_ok = all(
        int(rungs[index]["high_failure"]["remapped_row_count"])
        > int(rungs[index - 1]["high_failure"]["remapped_row_count"])
        and int(rungs[index]["high_failure"]["total_remap_manhattan_distance"])
        > int(rungs[index - 1]["high_failure"]["total_remap_manhattan_distance"])
        for index in range(1, len(rungs))
    )
    status, detail = pass_fail(
        monotonic_ok,
        "high-failure remap row and displacement totals increase across full-K rungs",
        "high-failure route-cost ladder is not monotonic",
    )
    checks.append({"id": "e1x_full_k_repair_route_cost_monotonic_high_failure", "status": status, "detail": detail})

    final = rungs[-1] if rungs else {}
    final_normal = final.get("normal", {})
    final_high = final.get("high_failure", {})
    final_ok = (
        int(final_normal.get("remapped_row_count", 0)) == 44
        and int(final_high.get("remapped_row_count", 0)) == 760
        and int(final_high.get("total_remap_manhattan_distance", 0))
        > int(final_normal.get("total_remap_manhattan_distance", 0)) * 5
        and int(final_high.get("max_remap_manhattan_distance", 0)) >= 300
        and len(final_high.get("kind_remapped_rows", {})) >= 6
    )
    status, detail = pass_fail(
        final_ok,
        "hyper-dense full-K remap route-cost spread covers high-failure spare displacement",
        "hyper-dense full-K route-cost distribution mismatch",
    )
    checks.append({"id": "e1x_full_k_repair_route_cost_hyper_dense_distribution", "status": status, "detail": detail})

    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "rung_count": len(rungs),
        "hyper_dense_normal_remapped_rows": int(final_normal.get("remapped_row_count", 0)),
        "hyper_dense_high_failure_remapped_rows": int(final_high.get("remapped_row_count", 0)),
        "hyper_dense_normal_total_remap_distance": int(
            final_normal.get("total_remap_manhattan_distance", 0)
        ),
        "hyper_dense_high_failure_total_remap_distance": int(
            final_high.get("total_remap_manhattan_distance", 0)
        ),
        "hyper_dense_high_failure_max_remap_distance": int(
            final_high.get("max_remap_manhattan_distance", 0)
        ),
        "hyper_dense_high_failure_average_remap_distance": float(
            final_high.get("average_remap_manhattan_distance", 0.0)
        ),
        "hyper_dense_high_vs_normal_remap_distance_ratio": (
            int(final_high.get("total_remap_manhattan_distance", 0))
            / max(1, int(final_normal.get("total_remap_manhattan_distance", 0)))
        ),
        "route_cost_ladder_sha256": canonical_sha256(rungs),
        "rungs": rungs,
        "residual_blocker": "full_output_real_weight_checksum_missing",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-full-k-repair-route-cost",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Remap-displacement audit for repair-aware full-K selected rows. It "
            "measures logical-to-physical spare displacement for selected rows under "
            "normal and high-failure repair manifests. This is not physical routing "
            "signoff, a full-output real-weight checksum, or silicon evidence."
        ),
        "evidence_paths": [
            "benchmarks/results/e1x-real-graph-model-load.placement.json",
            "benchmarks/results/e1x-real-graph-model-load.normal_repair_manifest.json",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_manifest.json",
            "build/reports/e1x_full_k_repair_kind_coverage.json",
            "build/reports/e1x_stratified_full_k_repair_execution.json",
            "build/reports/e1x_dense_stratified_full_k_repair_execution.json",
            "build/reports/e1x_ultra_dense_stratified_full_k_repair_execution.json",
            "build/reports/e1x_hyper_dense_stratified_full_k_repair_execution.json",
            "scripts/check_e1x_full_k_repair_route_cost.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    report.update(FALSE_CLAIM_FLAGS)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print(
            "BLOCKED: E1X full-K repair route cost failed: "
            + ", ".join(check["id"] for check in failures)
        )
        return 1
    print(f"PASS: E1X full-K repair route cost; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
