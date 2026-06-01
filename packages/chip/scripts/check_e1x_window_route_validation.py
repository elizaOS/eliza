#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from heapq import heappop, heappush
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_window_route_validation.json"

PLACEMENT = ROOT / "benchmarks/results/e1x-real-graph-model-load.placement.json"
WINDOW_REPAIR = ROOT / "build/reports/e1x_window_repair_linkage.json"

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

ROWS_PER_LAYER = 32768
FNV64_OFFSET = 0xCBF29CE484222325
FNV64_PRIME = 0x100000001B3
MASK64 = (1 << 64) - 1

FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "silicon_claim_allowed": False,
    "production_accelerator_claim_allowed": False,
    "unbounded_noc_liveness_claim_allowed": False,
    "full_output_execution_claim_allowed": False,
    "physical_routing_signoff_claim_allowed": False,
}


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def mix64(checksum: int, value: int) -> int:
    return ((checksum ^ (value & MASK64)) * FNV64_PRIME) & MASK64


def link_key(a: tuple[int, int], b: tuple[int, int]) -> tuple[tuple[int, int], tuple[int, int]]:
    return (a, b) if a <= b else (b, a)


def coord_key(coord: dict) -> tuple[int, int]:
    return int(coord["row"]), int(coord["col"])


def touched_window_coords(placement: dict) -> set[tuple[int, int]]:
    logical_cols = int(placement.get("logical_cols", 0))
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
    return {(core // logical_cols, core % logical_cols) for core in touched}


def touched_neighbor_edges(
    touched: set[tuple[int, int]],
) -> list[tuple[tuple[int, int], tuple[int, int]]]:
    edges = []
    for row, col in sorted(touched):
        for peer in ((row + 1, col), (row, col + 1)):
            if peer in touched:
                edges.append(((row, col), peer))
    return edges


def neighbors(
    coord: tuple[int, int], physical_rows: int, physical_cols: int
) -> list[tuple[int, int]]:
    row, col = coord
    candidates = ((row - 1, col), (row + 1, col), (row, col - 1), (row, col + 1))
    return [
        nxt for nxt in candidates if 0 <= nxt[0] < physical_rows and 0 <= nxt[1] < physical_cols
    ]


def route(
    start: tuple[int, int],
    goal: tuple[int, int],
    blocked_cores: set[tuple[int, int]],
    blocked_links: set[tuple[tuple[int, int], tuple[int, int]]],
    physical_rows: int,
    physical_cols: int,
) -> list[tuple[int, int]]:
    if start in blocked_cores or goal in blocked_cores:
        raise ValueError("blocked endpoint")
    frontier: list[tuple[int, int, tuple[int, int]]] = [
        (abs(start[0] - goal[0]) + abs(start[1] - goal[1]), 0, start)
    ]
    previous: dict[tuple[int, int], tuple[int, int] | None] = {start: None}
    cost: dict[tuple[int, int], int] = {start: 0}
    while frontier:
        _, current_cost, current = heappop(frontier)
        if current == goal:
            break
        if current_cost != cost[current]:
            continue
        for nxt in neighbors(current, physical_rows, physical_cols):
            if nxt in blocked_cores or link_key(current, nxt) in blocked_links:
                continue
            next_cost = current_cost + 1
            if next_cost >= cost.get(nxt, 1 << 60):
                continue
            previous[nxt] = current
            cost[nxt] = next_cost
            priority = next_cost + abs(nxt[0] - goal[0]) + abs(nxt[1] - goal[1])
            heappush(frontier, (priority, next_cost, nxt))
    if goal not in previous:
        raise ValueError(f"no repaired route from {start} to {goal}")
    path = [goal]
    while path[-1] != start:
        parent = previous[path[-1]]
        if parent is None:
            break
        path.append(parent)
    return list(reversed(path))


def validate_case(
    case: str, placement: dict, edges: list[tuple[tuple[int, int], tuple[int, int]]], paths: dict
) -> tuple[list[str], dict]:
    defect = load_json(paths["defect"])
    repair = load_json(paths["repair"])
    physical_rows = int(repair.get("physical_rows", 0))
    physical_cols = int(repair.get("physical_cols", 0))
    blocked_cores = {coord_key(coord) for coord in defect.get("blocked_cores", [])}
    blocked_links = {
        link_key(coord_key(link["a"]), coord_key(link["b"]))
        for link in defect.get("blocked_links", [])
    }
    remap = {
        coord_key(entry["logical"]): coord_key(entry["physical"])
        for entry in repair.get("remapped_cores", [])
    }
    route_checksum = FNV64_OFFSET
    route_errors: list[str] = []
    route_count = 0
    extra_hops = 0
    max_hops = 0
    remapped_edge_count = 0
    sampled_routes: list[dict[str, int | str]] = []
    for logical_from, logical_to in edges:
        physical_from = remap.get(logical_from, logical_from)
        physical_to = remap.get(logical_to, logical_to)
        try:
            path = route(
                physical_from,
                physical_to,
                blocked_cores,
                blocked_links,
                physical_rows,
                physical_cols,
            )
        except ValueError as exc:
            route_errors.append(f"{logical_from}->{logical_to}:{exc}")
            continue
        hops = len(path) - 1
        route_count += 1
        extra_hops += max(0, hops - 1)
        max_hops = max(max_hops, hops)
        remapped = physical_from != logical_from or physical_to != logical_to
        remapped_edge_count += 1 if remapped else 0
        for value in (logical_from[0], logical_from[1], logical_to[0], logical_to[1], hops):
            route_checksum = mix64(route_checksum, value)
        if len(sampled_routes) < 8 and remapped:
            sampled_routes.append(
                {
                    "logical_from_row": logical_from[0],
                    "logical_from_col": logical_from[1],
                    "logical_to_row": logical_to[0],
                    "logical_to_col": logical_to[1],
                    "physical_from_row": physical_from[0],
                    "physical_from_col": physical_from[1],
                    "physical_to_row": physical_to[0],
                    "physical_to_col": physical_to[1],
                    "hops": hops,
                }
            )
    summary = {
        "case": case,
        "window_neighbor_route_count": route_count,
        "window_extra_repair_hops": extra_hops,
        "window_max_repaired_neighbor_hops": max_hops,
        "window_remapped_neighbor_edge_count": remapped_edge_count,
        "window_average_extra_hops_per_neighbor": extra_hops / route_count if route_count else 0.0,
        "window_route_checksum": route_checksum,
        "sampled_remapped_window_routes": sampled_routes,
    }
    return route_errors, summary


def main() -> int:
    checks: list[dict[str, str]] = []
    paths = [PLACEMENT, WINDOW_REPAIR]
    for case_paths in CASES.values():
        paths.extend([case_paths["defect"], case_paths["repair"]])
    missing = [str(path.relative_to(ROOT)) for path in paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "window route-validation inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append(
        {"id": "e1x_window_route_validation_inputs_present", "status": status, "detail": detail}
    )

    placement = load_json(PLACEMENT) if PLACEMENT.is_file() else {}
    window_repair = load_json(WINDOW_REPAIR) if WINDOW_REPAIR.is_file() else {}
    deps_ok = (
        placement.get("schema") == "eliza.e1x.graph_mesh_placement.v1"
        and window_repair.get("status") == "PASS"
        and int(window_repair.get("summary", {}).get("window_touched_core_count", 0)) > 1_169
    )
    status, detail = pass_fail(
        deps_ok,
        "placement and window-repair linkage reports are linked and PASS",
        "window route-validation dependency missing, stale, or failing",
    )
    checks.append(
        {"id": "e1x_window_route_validation_dependencies_pass", "status": status, "detail": detail}
    )

    touched = touched_window_coords(placement)
    edges = touched_neighbor_edges(touched)
    edge_set_ok = (
        len(touched) == int(window_repair.get("summary", {}).get("window_touched_core_count", -1))
        and len(edges) > 963
    )
    status, detail = pass_fail(
        edge_set_ok,
        "window touched-core neighbor edge set is deterministic",
        "window touched-core neighbor edge count mismatch",
    )
    checks.append(
        {"id": "e1x_window_route_validation_edge_set", "status": status, "detail": detail}
    )

    case_summaries: dict[str, dict] = {}
    all_errors: list[str] = []
    for case, paths_for_case in CASES.items():
        errors, summary = validate_case(case, placement, edges, paths_for_case)
        case_summaries[case] = summary
        all_errors.extend(f"{case}:{error}" for error in errors)
        expected_ok = (
            int(summary["window_neighbor_route_count"]) == len(edges)
            and int(summary["window_extra_repair_hops"]) > 0
            and int(summary["window_max_repaired_neighbor_hops"]) > 1
            and int(summary["window_remapped_neighbor_edge_count"]) > 0
            and int(summary["window_route_checksum"]) != FNV64_OFFSET
        )
        status, detail = pass_fail(
            expected_ok,
            f"{case} window neighbor routes avoid blocked cores/links after repair",
            f"{case} window route metrics mismatch",
        )
        checks.append(
            {"id": f"e1x_window_route_validation_{case}", "status": status, "detail": detail}
        )

    route_ok = not all_errors
    status, detail = pass_fail(
        route_ok,
        "normal and high-failure route checks cover every window neighbor edge",
        "window route errors: " + ", ".join(all_errors[:8]),
    )
    checks.append(
        {"id": "e1x_window_route_validation_all_routes", "status": status, "detail": detail}
    )

    failures = [check for check in checks if check["status"] != "pass"]
    normal = case_summaries.get("normal", {})
    high = case_summaries.get("high_failure", {})
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "window_touched_core_count": len(touched),
        "window_neighbor_edge_count": len(edges),
        "normal_window_extra_repair_hops": int(normal.get("window_extra_repair_hops", 0)),
        "high_failure_window_extra_repair_hops": int(high.get("window_extra_repair_hops", 0)),
        "normal_window_max_repaired_neighbor_hops": int(
            normal.get("window_max_repaired_neighbor_hops", 0)
        ),
        "high_failure_window_max_repaired_neighbor_hops": int(
            high.get("window_max_repaired_neighbor_hops", 0)
        ),
        "normal_window_remapped_neighbor_edges": int(
            normal.get("window_remapped_neighbor_edge_count", 0)
        ),
        "high_failure_window_remapped_neighbor_edges": int(
            high.get("window_remapped_neighbor_edge_count", 0)
        ),
        "normal_window_route_checksum": int(normal.get("window_route_checksum", 0)),
        "high_failure_window_route_checksum": int(high.get("window_route_checksum", 0)),
        "high_vs_normal_window_extra_hop_ratio": (
            float(high.get("window_extra_repair_hops", 0))
            / max(1.0, float(normal.get("window_extra_repair_hops", 0)))
        ),
        "case_summaries": case_summaries,
        "residual_blocker": "full_output_vectorized_tensor_fabric_executor_missing",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-window-route-validation",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Validates repaired physical routes for adjacent logical neighbor edges "
            "inside the executed vector-window touched-core set under normal and "
            "high-failure repair manifests. This is bounded architecture route "
            "validation, not full unbounded NoC liveness or silicon evidence."
        ),
        "evidence_paths": [
            "benchmarks/results/e1x-real-graph-model-load.placement.json",
            "benchmarks/results/e1x-real-graph-model-load.normal_defect_map.json",
            "benchmarks/results/e1x-real-graph-model-load.normal_repair_manifest.json",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_defect_map.json",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_manifest.json",
            "build/reports/e1x_window_repair_linkage.json",
            "scripts/check_e1x_window_route_validation.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    report.update(FALSE_CLAIM_FLAGS)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print(
            "BLOCKED: E1X window route validation failed: " + ", ".join(c["id"] for c in failures)
        )
        return 1
    print(f"PASS: E1X window route validation; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
