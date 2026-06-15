#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_full_k_repair_kind_coverage.json"

PLACEMENT = ROOT / "benchmarks/results/e1x-real-graph-model-load.placement.json"
FULL_K_REPAIR_LADDER = ROOT / "build/reports/e1x_full_k_repair_coverage_ladder.json"
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
EXPECTED_KINDS = {
    "attn_out_proj",
    "attn_qkv_proj",
    "embedding",
    "lm_head",
    "mlp_down_proj",
    "mlp_gate_proj",
    "mlp_up_proj",
    "norm",
}
FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "silicon_claim_allowed": False,
    "production_accelerator_claim_allowed": False,
    "full_output_execution_claim_allowed": False,
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


def selected_rows(row_count: int, rows_per_layer: int) -> list[int]:
    if row_count <= rows_per_layer:
        return list(range(row_count))
    return sorted(
        {round(index * (row_count - 1) / (rows_per_layer - 1)) for index in range(rows_per_layer)}
    )


def coord_key(coord: dict) -> tuple[int, int]:
    return int(coord["row"]), int(coord["col"])


def load_remap(path: Path) -> tuple[dict, set[tuple[int, int]]]:
    report = load_json(path)
    remapped = {coord_key(entry["logical"]) for entry in report.get("remapped_cores", [])}
    return report, remapped


def logical_core_for_row(layer: dict, output_row: int) -> int:
    return int(layer["core_index_start"]) + (output_row // int(layer["rows_per_core"]))


def add_count(target: dict[str, int], key: str, value: int = 1) -> None:
    target[key] = target.get(key, 0) + value


def build_rung_summary(
    layers: list[dict],
    logical_cols: int,
    rows_per_layer: int,
    normal_remap: set[tuple[int, int]],
    high_failure_remap: set[tuple[int, int]],
) -> dict:
    kind_rows: dict[str, int] = {}
    kind_macs: dict[str, int] = {}
    kind_touched_cores: dict[str, set[int]] = {}
    normal_kind_remaps: dict[str, int] = {}
    high_failure_kind_remaps: dict[str, int] = {}
    touched_cores: set[int] = set()
    total_rows = 0
    total_macs = 0
    for layer in layers:
        kind = str(layer["kind"])
        cols = int(layer["cols"])
        kind_touched_cores.setdefault(kind, set())
        for output_row in selected_rows(int(layer["rows"]), rows_per_layer):
            logical_core = logical_core_for_row(layer, output_row)
            logical = (logical_core // logical_cols, logical_core % logical_cols)
            total_rows += 1
            total_macs += cols
            touched_cores.add(logical_core)
            kind_touched_cores[kind].add(logical_core)
            add_count(kind_rows, kind)
            add_count(kind_macs, kind, cols)
            if logical in normal_remap:
                add_count(normal_kind_remaps, kind)
            if logical in high_failure_remap:
                add_count(high_failure_kind_remaps, kind)
    return {
        "rows_per_layer": rows_per_layer,
        "row_count": total_rows,
        "mac_count": total_macs,
        "touched_logical_core_count": len(touched_cores),
        "kind_row_counts": dict(sorted(kind_rows.items())),
        "kind_mac_counts": dict(sorted(kind_macs.items())),
        "kind_touched_core_counts": {
            key: len(value) for key, value in sorted(kind_touched_cores.items())
        },
        "normal_kind_remapped_rows": dict(sorted(normal_kind_remaps.items())),
        "high_failure_kind_remapped_rows": dict(sorted(high_failure_kind_remaps.items())),
    }


def main() -> int:
    checks: list[dict[str, str]] = []
    paths = [PLACEMENT, FULL_K_REPAIR_LADDER, NORMAL_REPAIR, HIGH_FAILURE_REPAIR] + [
        path for _, _, path in RUNG_REPORTS
    ]
    missing = [str(path.relative_to(ROOT)) for path in paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "full-K repair kind coverage inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append(
        {"id": "e1x_full_k_repair_kind_coverage_inputs_present", "status": status, "detail": detail}
    )

    placement = load_json(PLACEMENT) if PLACEMENT.is_file() else {}
    ladder = load_json(FULL_K_REPAIR_LADDER) if FULL_K_REPAIR_LADDER.is_file() else {}
    normal_report, normal_remap = (
        load_remap(NORMAL_REPAIR) if NORMAL_REPAIR.is_file() else ({}, set())
    )
    high_report, high_remap = (
        load_remap(HIGH_FAILURE_REPAIR) if HIGH_FAILURE_REPAIR.is_file() else ({}, set())
    )
    layers = [layer for layer in placement.get("layers", []) if isinstance(layer, dict)]
    logical_cols = int(placement.get("logical_cols", 0))
    deps_ok = (
        placement.get("schema") == "eliza.e1x.graph_mesh_placement.v1"
        and len(layers) == 283
        and set(str(layer.get("kind")) for layer in layers) == EXPECTED_KINDS
        and ladder.get("status") == "PASS"
        and int(ladder.get("summary", {}).get("rung_count", 0)) == 4
        and normal_report.get("artifact_sha256") == EXPECTED_REPAIR_SHA256["normal"]
        and high_report.get("artifact_sha256") == EXPECTED_REPAIR_SHA256["high_failure"]
        and int(normal_report.get("remapped_core_count", 0)) == 340
        and int(high_report.get("remapped_core_count", 0)) == 3_510
    )
    status, detail = pass_fail(
        deps_ok,
        "placement, full-K ladder, and normal/high repair manifests are linked",
        "full-K repair kind coverage dependency mismatch",
    )
    checks.append(
        {
            "id": "e1x_full_k_repair_kind_coverage_dependencies_pass",
            "status": status,
            "detail": detail,
        }
    )

    rungs = []
    for name, rows_per_layer, path in RUNG_REPORTS:
        report = load_json(path) if path.is_file() else {}
        report_summary = report.get("summary", {})
        rung = build_rung_summary(layers, logical_cols, rows_per_layer, normal_remap, high_remap)
        rung["name"] = name
        rungs.append(rung)
        kind_ok = (
            report.get("status") == "PASS"
            and int(report_summary.get("executed_stratified_full_k_row_count", 0))
            == int(rung["row_count"])
            and int(report_summary.get("executed_stratified_full_k_mac_count", 0))
            == int(rung["mac_count"])
            and int(report_summary.get("touched_logical_core_count", 0))
            == int(rung["touched_logical_core_count"])
            and int(report_summary.get("normal_touched_remapped_rows", 0))
            == sum(int(value) for value in rung["normal_kind_remapped_rows"].values())
            and int(report_summary.get("high_failure_touched_remapped_rows", 0))
            == sum(int(value) for value in rung["high_failure_kind_remapped_rows"].values())
            and set(rung["kind_row_counts"].keys()) == EXPECTED_KINDS
        )
        status, detail = pass_fail(
            kind_ok,
            f"{name} selected rows cover all layer kinds and match repair report totals",
            f"{name} kind/remap totals do not match repair report",
        )
        checks.append(
            {"id": f"e1x_full_k_repair_kind_coverage_{name}", "status": status, "detail": detail}
        )

    monotonic_kind_ok = all(
        int(rungs[index]["kind_row_counts"][kind])
        == int(rungs[index - 1]["kind_row_counts"][kind]) * 2
        for index in range(1, len(rungs))
        for kind in EXPECTED_KINDS
    )
    status, detail = pass_fail(
        monotonic_kind_ok,
        "every layer kind doubles selected full-K rows at each ladder rung",
        "kind row counts are not monotonic by rung",
    )
    checks.append(
        {
            "id": "e1x_full_k_repair_kind_coverage_monotonic_by_kind",
            "status": status,
            "detail": detail,
        }
    )

    final = rungs[-1] if rungs else {}
    final_high_remaps = final.get("high_failure_kind_remapped_rows", {})
    final_normal_remaps = final.get("normal_kind_remapped_rows", {})
    final_ok = (
        int(final.get("row_count", 0)) == 36_224
        and int(final.get("mac_count", 0)) == 176_957_568
        and int(final.get("touched_logical_core_count", 0)) == 25_937
        and sum(int(value) for value in final_high_remaps.values()) == 760
        and sum(int(value) for value in final_normal_remaps.values()) == 44
        and len(final_high_remaps) >= 6
        and int(final["kind_row_counts"]["embedding"]) == 128
        and int(final["kind_row_counts"]["lm_head"]) == 128
        and int(final["kind_row_counts"]["norm"]) == 10_368
    )
    status, detail = pass_fail(
        final_ok,
        "hyper-dense rung covers all kinds and high-failure remaps span the graph",
        "hyper-dense kind/remap coverage mismatch",
    )
    checks.append(
        {
            "id": "e1x_full_k_repair_kind_coverage_hyper_dense_distribution",
            "status": status,
            "detail": detail,
        }
    )

    failures = [check for check in checks if check["status"] != "pass"]
    final_kind_rows = final.get("kind_row_counts", {})
    final_kind_macs = final.get("kind_mac_counts", {})
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "rung_count": len(rungs),
        "kind_count": len(EXPECTED_KINDS),
        "hyper_dense_row_count": int(final.get("row_count", 0)),
        "hyper_dense_mac_count": int(final.get("mac_count", 0)),
        "hyper_dense_touched_logical_core_count": int(final.get("touched_logical_core_count", 0)),
        "hyper_dense_normal_remapped_rows": sum(
            int(value) for value in final_normal_remaps.values()
        ),
        "hyper_dense_high_failure_remapped_rows": sum(
            int(value) for value in final_high_remaps.values()
        ),
        "hyper_dense_embedding_rows": int(final_kind_rows.get("embedding", 0)),
        "hyper_dense_lm_head_rows": int(final_kind_rows.get("lm_head", 0)),
        "hyper_dense_norm_rows": int(final_kind_rows.get("norm", 0)),
        "hyper_dense_attn_qkv_macs": int(final_kind_macs.get("attn_qkv_proj", 0)),
        "hyper_dense_mlp_down_macs": int(final_kind_macs.get("mlp_down_proj", 0)),
        "kind_rung_summary_sha256": canonical_sha256(rungs),
        "rungs": rungs,
        "residual_blocker": "full_output_real_weight_checksum_missing",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-full-k-repair-kind-coverage",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Kind-distribution audit for repair-aware full-K selected rows. It "
            "reconstructs selected rows from placement and repair manifests to prove "
            "the 16/32/64/128-row ladder covers every layer kind and remap scenario. "
            "This is not a full-output real-weight checksum and not silicon evidence."
        ),
        "evidence_paths": [
            "benchmarks/results/e1x-real-graph-model-load.placement.json",
            "benchmarks/results/e1x-real-graph-model-load.normal_repair_manifest.json",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_manifest.json",
            "build/reports/e1x_full_k_repair_coverage_ladder.json",
            "build/reports/e1x_stratified_full_k_repair_execution.json",
            "build/reports/e1x_dense_stratified_full_k_repair_execution.json",
            "build/reports/e1x_ultra_dense_stratified_full_k_repair_execution.json",
            "build/reports/e1x_hyper_dense_stratified_full_k_repair_execution.json",
            "scripts/check_e1x_full_k_repair_kind_coverage.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    report.update(FALSE_CLAIM_FLAGS)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print(
            "BLOCKED: E1X full-K repair kind coverage failed: "
            + ", ".join(check["id"] for check in failures)
        )
        return 1
    print(f"PASS: E1X full-K repair kind coverage; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
