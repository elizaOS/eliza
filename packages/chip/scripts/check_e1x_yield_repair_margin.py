#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_yield_repair_margin.json"

CASES = {
    "normal": {
        "defect": ROOT / "benchmarks/results/e1x-real-graph-model-load.normal_defect_map.json",
        "repair": ROOT / "benchmarks/results/e1x-real-graph-model-load.normal_repair_manifest.json",
    },
    "high_failure": {
        "defect": ROOT
        / "benchmarks/results/e1x-real-graph-model-load.high_failure_defect_map.json",
        "repair": ROOT
        / "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_manifest.json",
    },
}


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def canonical_sha256_without_artifact(data: dict) -> str:
    payload = dict(data)
    payload.pop("artifact_sha256", None)
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return sha256(encoded).hexdigest()


def coord_key(coord: dict) -> tuple[int, int]:
    return int(coord["row"]), int(coord["col"])


def link_key(a: tuple[int, int], b: tuple[int, int]) -> tuple[tuple[int, int], tuple[int, int]]:
    return (a, b) if a <= b else (b, a)


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def validate_case(
    case: str, defect_path: Path, repair_path: Path
) -> tuple[list[dict[str, str]], dict]:
    checks: list[dict[str, str]] = []
    summary: dict[str, int | float | str | bool] = {"case": case}
    paths_ok = defect_path.is_file() and repair_path.is_file()
    status, detail = pass_fail(
        paths_ok,
        f"{case} defect map and repair manifest present",
        f"missing {defect_path.relative_to(ROOT)} or {repair_path.relative_to(ROOT)}",
    )
    checks.append({"id": f"e1x_yield_{case}_paths_present", "status": status, "detail": detail})
    if not paths_ok:
        return checks, summary

    defect = load_json(defect_path)
    repair = load_json(repair_path)
    schema_ok = (
        defect.get("schema") == "eliza.e1x.wafer_sort_defect_map.v1"
        and repair.get("schema") == "eliza.e1x.repair_manifest.v1"
    )
    status, detail = pass_fail(schema_ok, f"{case} schemas match defect/repair contracts")
    checks.append({"id": f"e1x_yield_{case}_schemas", "status": status, "detail": detail})

    hashes_ok = (
        defect.get("artifact_sha256") == canonical_sha256_without_artifact(defect)
        and repair.get("artifact_sha256") == canonical_sha256_without_artifact(repair)
        and repair.get("source_defect_map_sha256") == defect.get("artifact_sha256")
    )
    status, detail = pass_fail(
        hashes_ok,
        f"{case} artifact hashes and defect->repair link are consistent",
    )
    checks.append({"id": f"e1x_yield_{case}_hash_links", "status": status, "detail": detail})

    blocked_cores = {coord_key(coord) for coord in defect.get("blocked_cores", [])}
    blocked_links = {
        link_key(coord_key(link["a"]), coord_key(link["b"]))
        for link in defect.get("blocked_links", [])
    }
    remaps = repair.get("remapped_cores", [])
    logical_remaps = [coord_key(entry["logical"]) for entry in remaps]
    physical_remaps = [coord_key(entry["physical"]) for entry in remaps]
    logical_rows = int(repair.get("logical_rows", 0))
    logical_cols = int(repair.get("logical_cols", 0))
    spare_cores = int(repair.get("spare_cores", 0))
    remap_count = int(repair.get("remapped_core_count", -1))
    blocked_logical_cores = {
        coord
        for coord in blocked_cores
        if 0 <= coord[0] < logical_rows and 0 <= coord[1] < logical_cols
    }
    remap_integrity_ok = (
        remap_count == len(remaps)
        and len(set(logical_remaps)) == len(logical_remaps)
        and len(set(physical_remaps)) == len(physical_remaps)
        and set(logical_remaps) <= blocked_logical_cores
        and not (set(physical_remaps) & blocked_cores)
        and remap_count <= spare_cores
    )
    status, detail = pass_fail(
        remap_integrity_ok,
        f"{case} remaps are unique, avoid blocked physical targets, and fit spare budget",
        f"{case} remap integrity failed",
    )
    checks.append({"id": f"e1x_yield_{case}_remap_integrity", "status": status, "detail": detail})

    validation = repair.get("validation", {})
    validation_ok = (
        validation.get("repaired_logical_mesh") is True
        and int(validation.get("logical_neighbor_paths_checked", 0)) > 0
        and float(validation.get("average_extra_hops_per_neighbor", -1.0)) >= 0.0
        and int(validation.get("max_repaired_neighbor_hops", 0)) >= 1
    )
    status, detail = pass_fail(
        validation_ok,
        f"{case} repair validation reports repaired logical mesh and sampled route checks",
    )
    checks.append({"id": f"e1x_yield_{case}_repair_validation", "status": status, "detail": detail})

    route_errors = []
    for index, route in enumerate(repair.get("sampled_routes", [])):
        path = [coord_key(coord) for coord in route.get("path", [])]
        if len(path) < 2:
            route_errors.append(f"{index}:short")
            continue
        if path[0] != coord_key(route["physical_from"]) or path[-1] != coord_key(
            route["physical_to"]
        ):
            route_errors.append(f"{index}:endpoint")
        for coord in path:
            if coord in blocked_cores:
                route_errors.append(f"{index}:blocked_core")
                break
        for a, b in zip(path, path[1:], strict=False):
            manhattan = abs(a[0] - b[0]) + abs(a[1] - b[1])
            if manhattan != 1:
                route_errors.append(f"{index}:non_neighbor")
                break
            if link_key(a, b) in blocked_links:
                route_errors.append(f"{index}:blocked_link")
                break
    route_paths_ok = not route_errors and len(repair.get("sampled_routes", [])) >= 64
    status, detail = pass_fail(
        route_paths_ok,
        f"{case} sampled repair routes avoid blocked cores/links",
        f"{case} route errors: " + ", ".join(route_errors[:8]),
    )
    checks.append({"id": f"e1x_yield_{case}_sampled_routes", "status": status, "detail": detail})

    spare_utilization = remap_count / max(1, spare_cores)
    summary.update(
        {
            "scenario": str(defect.get("scenario", "")),
            "core_failure_rate": float(defect.get("core_failure_rate", 0.0)),
            "link_failure_rate": float(defect.get("link_failure_rate", 0.0)),
            "blocked_core_count": int(defect.get("blocked_core_count", 0)),
            "blocked_link_count": int(defect.get("blocked_link_count", 0)),
            "blocked_logical_core_count": len(blocked_logical_cores),
            "remapped_core_count": remap_count,
            "spare_cores": spare_cores,
            "spare_utilization": spare_utilization,
            "spare_margin": spare_cores - remap_count,
            "sampled_route_count": len(repair.get("sampled_routes", [])),
            "logical_neighbor_paths_checked": int(
                validation.get("logical_neighbor_paths_checked", 0)
            ),
            "average_extra_hops_per_neighbor": float(
                validation.get("average_extra_hops_per_neighbor", 0.0)
            ),
            "max_repaired_neighbor_hops": int(validation.get("max_repaired_neighbor_hops", 0)),
            "defect_map_sha256": str(defect.get("artifact_sha256", "")),
            "repair_manifest_sha256": str(repair.get("artifact_sha256", "")),
        }
    )
    return checks, summary


def main() -> int:
    checks: list[dict[str, str]] = []
    case_summaries: dict[str, dict] = {}
    for case, paths in CASES.items():
        case_checks, case_summary = validate_case(case, paths["defect"], paths["repair"])
        checks.extend(case_checks)
        case_summaries[case] = case_summary

    normal = case_summaries.get("normal", {})
    high = case_summaries.get("high_failure", {})
    stress_ok = (
        float(high.get("core_failure_rate", 0.0)) > float(normal.get("core_failure_rate", 0.0))
        and int(high.get("remapped_core_count", 0)) > int(normal.get("remapped_core_count", 0))
        and float(high.get("spare_utilization", 0.0)) < 0.5
        and int(high.get("spare_margin", 0)) > 0
        and float(high.get("average_extra_hops_per_neighbor", 0.0))
        > float(normal.get("average_extra_hops_per_neighbor", 0.0))
    )
    status, detail = pass_fail(
        stress_ok,
        "high-failure scenario stresses repair more than normal while preserving spare margin",
    )
    checks.append(
        {"id": "e1x_yield_high_failure_stress_margin", "status": status, "detail": detail}
    )

    failures = [check for check in checks if check["status"] != "pass"]
    high_spare_util = float(high.get("spare_utilization", 0.0))
    normal_spare_util = float(normal.get("spare_utilization", 0.0))
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "case_count": len(case_summaries),
        "normal_remapped_cores": int(normal.get("remapped_core_count", 0)),
        "high_failure_remapped_cores": int(high.get("remapped_core_count", 0)),
        "normal_spare_utilization": normal_spare_util,
        "high_failure_spare_utilization": high_spare_util,
        "high_failure_spare_margin": int(high.get("spare_margin", 0)),
        "high_failure_blocked_core_count": int(high.get("blocked_core_count", 0)),
        "high_failure_blocked_link_count": int(high.get("blocked_link_count", 0)),
        "high_failure_route_checks": int(high.get("logical_neighbor_paths_checked", 0)),
        "high_vs_normal_remap_ratio": (
            int(high.get("remapped_core_count", 0))
            / max(1, int(normal.get("remapped_core_count", 0)))
        ),
        "high_vs_normal_extra_hop_ratio": (
            float(high.get("average_extra_hops_per_neighbor", 0.0))
            / max(1e-12, float(normal.get("average_extra_hops_per_neighbor", 0.0)))
        ),
        "cases": case_summaries,
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-yield-repair-margin",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "E1X architecture-simulation yield/repair-margin gate over generated wafer-sort "
            "defect maps and repair manifests. This is not foundry wafer sort, ATPG coverage, "
            "silicon yield characterization, or production binning evidence."
        ),
        "evidence_paths": [
            "benchmarks/results/e1x-real-graph-model-load.normal_defect_map.json",
            "benchmarks/results/e1x-real-graph-model-load.normal_repair_manifest.json",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_defect_map.json",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_manifest.json",
            "scripts/check_e1x_yield_repair_margin.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X yield repair margin failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X yield repair margin; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
