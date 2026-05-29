#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_window_repair_linkage.json"

PLACEMENT = ROOT / "benchmarks/results/e1x-real-graph-model-load.placement.json"
WINDOW_SHARD = ROOT / "build/reports/e1x_window_shard_linkage.json"
YIELD_REPAIR = ROOT / "build/reports/e1x_yield_repair_margin.json"

CASES = {
    "normal": {
        "defect": ROOT / "benchmarks/results/e1x-real-graph-model-load.normal_defect_map.json",
        "repair": ROOT / "benchmarks/results/e1x-real-graph-model-load.normal_repair_manifest.json",
        "expected_blocked_touched": 2,
        "expected_repair_sha256": "157f8f7eab101ae4f9e6cc6d69c150b9403189ca3e31523e56b6c331104d0528",
    },
    "high_failure": {
        "defect": ROOT / "benchmarks/results/e1x-real-graph-model-load.high_failure_defect_map.json",
        "repair": ROOT / "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_manifest.json",
        "expected_blocked_touched": 24,
        "expected_repair_sha256": "c8ad0a7c1a907447b0624aecbb73ef36f763be20b43d253a35c56899a153d781",
    },
}

ROWS_PER_LAYER = 64


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def canonical_sha256(data: object) -> str:
    encoded = json.dumps(data, sort_keys=True, separators=(",", ":")).encode()
    return sha256(encoded).hexdigest()


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


def validate_case(case: str, placement: dict, touched_cores: list[int], paths: dict) -> tuple[list[str], dict]:
    defect = load_json(paths["defect"])
    repair = load_json(paths["repair"])
    logical_cols = int(placement.get("logical_cols", 0))
    blocked = {coord_key(coord) for coord in defect.get("blocked_cores", [])}
    remap = {
        coord_key(entry["logical"]): coord_key(entry["physical"])
        for entry in repair.get("remapped_cores", [])
    }
    errors: list[str] = []
    remapped_records: list[dict[str, int | str]] = []
    direct_count = 0
    remapped_count = 0
    physical_targets: set[tuple[int, int]] = set()
    for logical_core_index in touched_cores:
        logical = (logical_core_index // logical_cols, logical_core_index % logical_cols)
        physical = remap.get(logical, logical)
        physical_targets.add(physical)
        if logical in blocked:
            if logical not in remap:
                errors.append(f"missing-remap:{logical_core_index}")
                continue
            remapped_count += 1
            if len(remapped_records) < 8:
                remapped_records.append({
                    "logical_core_index": logical_core_index,
                    "logical_row": logical[0],
                    "logical_col": logical[1],
                    "physical_row": physical[0],
                    "physical_col": physical[1],
                })
        else:
            direct_count += 1
        if physical in blocked:
            errors.append(f"blocked-physical:{logical_core_index}")
    summary = {
        "case": case,
        "defect_map_sha256": str(defect.get("artifact_sha256", "")),
        "repair_manifest_sha256": str(repair.get("artifact_sha256", "")),
        "total_remapped_core_count": int(repair.get("remapped_core_count", 0)),
        "window_touched_core_count": len(touched_cores),
        "window_direct_core_count": direct_count,
        "window_remapped_core_count": remapped_count,
        "window_unique_physical_core_count": len(physical_targets),
        "sampled_window_remaps": remapped_records,
    }
    return errors, summary


def main() -> int:
    checks: list[dict[str, str]] = []
    paths = [PLACEMENT, WINDOW_SHARD, YIELD_REPAIR]
    for case_paths in CASES.values():
        paths.extend([case_paths["defect"], case_paths["repair"]])
    missing = [str(path.relative_to(ROOT)) for path in paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "window-repair linkage inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append({"id": "e1x_window_repair_linkage_inputs_present", "status": status, "detail": detail})

    placement = load_json(PLACEMENT) if PLACEMENT.is_file() else {}
    window_shard = load_json(WINDOW_SHARD) if WINDOW_SHARD.is_file() else {}
    yield_repair = load_json(YIELD_REPAIR) if YIELD_REPAIR.is_file() else {}
    deps_ok = (
        placement.get("schema") == "eliza.e1x.graph_mesh_placement.v1"
        and window_shard.get("status") == "PASS"
        and int(window_shard.get("summary", {}).get("window_touched_shard_records", 0)) == 1_169
        and yield_repair.get("status") == "PASS"
        and int(yield_repair.get("summary", {}).get("high_failure_remapped_cores", 0)) == 3_510
    )
    status, detail = pass_fail(
        deps_ok,
        "placement, window-shard linkage, and yield/repair-margin reports are linked and PASS",
        "window-repair dependency report missing, stale, or failing",
    )
    checks.append({"id": "e1x_window_repair_linkage_dependencies_pass", "status": status, "detail": detail})

    touched_cores = touched_window_cores(placement)
    touched_sha256 = canonical_sha256(touched_cores)
    touched_ok = len(touched_cores) == 1_169
    status, detail = pass_fail(
        touched_ok,
        "window touched-core set matches window-shard linkage coverage",
        "window touched-core count mismatch",
    )
    checks.append({"id": "e1x_window_repair_linkage_touched_cores", "status": status, "detail": detail})

    case_summaries: dict[str, dict] = {}
    all_errors: list[str] = []
    for case, paths_for_case in CASES.items():
        if not paths_for_case["defect"].is_file() or not paths_for_case["repair"].is_file():
            all_errors.append(f"missing:{case}")
            continue
        errors, summary = validate_case(case, placement, touched_cores, paths_for_case)
        case_summaries[case] = summary
        all_errors.extend(f"{case}:{error}" for error in errors)
        expected_ok = (
            int(summary["window_remapped_core_count"]) == int(paths_for_case["expected_blocked_touched"])
            and int(summary["window_direct_core_count"])
            == len(touched_cores) - int(paths_for_case["expected_blocked_touched"])
            and int(summary["window_unique_physical_core_count"]) == len(touched_cores)
            and summary["repair_manifest_sha256"] == paths_for_case["expected_repair_sha256"]
        )
        status, detail = pass_fail(
            expected_ok,
            f"{case} repair manifest maps touched window cores to usable physical cores",
            f"{case} touched-core repair mapping mismatch",
        )
        checks.append({"id": f"e1x_window_repair_linkage_{case}_coverage", "status": status, "detail": detail})

    route_ok = not all_errors
    status, detail = pass_fail(
        route_ok,
        "normal and high-failure repair manifests cover every window-touched logical core",
        "window repair mapping errors: " + ", ".join(all_errors[:8]),
    )
    checks.append({"id": "e1x_window_repair_linkage_all_touched_cores_repaired", "status": status, "detail": detail})

    failures = [check for check in checks if check["status"] != "pass"]
    normal = case_summaries.get("normal", {})
    high = case_summaries.get("high_failure", {})
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "window_touched_core_count": len(touched_cores),
        "window_touched_core_sha256": touched_sha256,
        "normal_window_remapped_core_count": int(normal.get("window_remapped_core_count", 0)),
        "high_failure_window_remapped_core_count": int(high.get("window_remapped_core_count", 0)),
        "normal_window_direct_core_count": int(normal.get("window_direct_core_count", 0)),
        "high_failure_window_direct_core_count": int(high.get("window_direct_core_count", 0)),
        "normal_total_remapped_core_count": int(normal.get("total_remapped_core_count", 0)),
        "high_failure_total_remapped_core_count": int(high.get("total_remapped_core_count", 0)),
        "window_high_vs_normal_remap_ratio": (
            int(high.get("window_remapped_core_count", 0))
            / max(1, int(normal.get("window_remapped_core_count", 0)))
        ),
        "case_summaries": case_summaries,
        "routed_window_checksum": int(window_shard.get("summary", {}).get("routed_window_checksum", 0)),
        "residual_blocker": "full_output_vectorized_tensor_fabric_executor_missing",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-window-repair-linkage",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Maps the executed vector-window touched logical cores through normal "
            "and high-failure repair manifests, proving those window cores have "
            "non-defective physical targets after reroute. This is architecture "
            "repair-manifest evidence, not foundry wafer-sort or silicon evidence."
        ),
        "evidence_paths": [
            "benchmarks/results/e1x-real-graph-model-load.placement.json",
            "benchmarks/results/e1x-real-graph-model-load.normal_defect_map.json",
            "benchmarks/results/e1x-real-graph-model-load.normal_repair_manifest.json",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_defect_map.json",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_manifest.json",
            "build/reports/e1x_window_shard_linkage.json",
            "build/reports/e1x_yield_repair_margin.json",
            "scripts/check_e1x_window_repair_linkage.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X window-repair linkage failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X window-repair linkage; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
