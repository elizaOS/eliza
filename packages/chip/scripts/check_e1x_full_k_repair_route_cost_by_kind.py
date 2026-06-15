#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_full_k_repair_route_cost_by_kind.json"

ROUTE_COST = ROOT / "build/reports/e1x_full_k_repair_route_cost.json"
KIND_COVERAGE = ROOT / "build/reports/e1x_full_k_repair_kind_coverage.json"
NORMAL_KINDS = {
    "attn_out_proj",
    "attn_qkv_proj",
    "mlp_down_proj",
    "mlp_gate_proj",
    "mlp_up_proj",
}
ALL_KINDS = {
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


def int_sum(values: dict) -> int:
    return sum(int(value) for value in values.values())


def main() -> int:
    checks: list[dict[str, str]] = []
    missing = [
        str(path.relative_to(ROOT)) for path in (ROUTE_COST, KIND_COVERAGE) if not path.is_file()
    ]
    status, detail = pass_fail(
        not missing,
        "full-K repair route-cost-by-kind inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append(
        {
            "id": "e1x_full_k_repair_route_cost_by_kind_inputs_present",
            "status": status,
            "detail": detail,
        }
    )

    route_cost = load_json(ROUTE_COST) if ROUTE_COST.is_file() else {}
    kind_coverage = load_json(KIND_COVERAGE) if KIND_COVERAGE.is_file() else {}
    route_summary = route_cost.get("summary", {})
    kind_summary = kind_coverage.get("summary", {})
    deps_ok = (
        route_cost.get("status") == "PASS"
        and kind_coverage.get("status") == "PASS"
        and int(route_summary.get("rung_count", 0)) == 4
        and int(kind_summary.get("kind_count", 0)) == 8
        and route_summary.get("route_cost_ladder_sha256")
        == "0580b6c27b4aa4347ffcf0e167b251cb1b6c85444947fb58dda5989d2ba5e1dc"
        and kind_summary.get("kind_rung_summary_sha256")
        == "6d950882a3ecc98af6f0ae571a8c9715579b8850467694b18bcbf524976b4635"
    )
    status, detail = pass_fail(
        deps_ok,
        "route-cost and kind-coverage reports are linked and passing",
        "route-cost-by-kind dependency mismatch",
    )
    checks.append(
        {
            "id": "e1x_full_k_repair_route_cost_by_kind_dependencies_pass",
            "status": status,
            "detail": detail,
        }
    )

    rungs = route_summary.get("rungs", [])
    final = rungs[-1] if isinstance(rungs, list) and rungs else {}
    final_normal = final.get("normal", {}) if isinstance(final, dict) else {}
    final_high = final.get("high_failure", {}) if isinstance(final, dict) else {}
    normal_rows = final_normal.get("kind_remapped_rows", {})
    normal_distance = final_normal.get("kind_total_remap_manhattan_distance", {})
    high_rows = final_high.get("kind_remapped_rows", {})
    high_distance = final_high.get("kind_total_remap_manhattan_distance", {})

    kind_set_ok = (
        set(normal_rows) == NORMAL_KINDS
        and set(normal_distance) == NORMAL_KINDS
        and set(high_rows) == ALL_KINDS
        and set(high_distance) == ALL_KINDS
    )
    status, detail = pass_fail(
        kind_set_ok,
        "normal remaps cover matmul kinds and high-failure remaps cover all eight kinds",
        "route-cost kind sets do not match expected normal/high distributions",
    )
    checks.append(
        {"id": "e1x_full_k_repair_route_cost_by_kind_sets", "status": status, "detail": detail}
    )

    totals_ok = (
        int_sum(normal_rows) == int(final_normal.get("remapped_row_count", 0)) == 44
        and int_sum(high_rows) == int(final_high.get("remapped_row_count", 0)) == 760
        and int_sum(normal_distance)
        == int(final_normal.get("total_remap_manhattan_distance", 0))
        == 6_824
        and int_sum(high_distance)
        == int(final_high.get("total_remap_manhattan_distance", 0))
        == 107_180
    )
    status, detail = pass_fail(
        totals_ok,
        "per-kind remap row and distance totals match hyper-dense aggregate route costs",
        "per-kind remap row or distance totals do not match aggregates",
    )
    checks.append(
        {"id": "e1x_full_k_repair_route_cost_by_kind_totals", "status": status, "detail": detail}
    )

    high_hotspots_ok = (
        int(high_rows.get("norm", 0)) == 256
        and int(high_distance.get("norm", 0)) == 29_696
        and int(high_rows.get("attn_qkv_proj", 0)) == 109
        and int(high_distance.get("attn_qkv_proj", 0)) == 17_494
        and int(high_distance.get("mlp_down_proj", 0)) == 14_055
        and max(high_distance, key=lambda key: int(high_distance[key])) == "norm"
    )
    status, detail = pass_fail(
        high_hotspots_ok,
        "high-failure route displacement hotspots are pinned by layer kind",
        "high-failure route displacement hotspots changed",
    )
    checks.append(
        {
            "id": "e1x_full_k_repair_route_cost_by_kind_high_hotspots",
            "status": status,
            "detail": detail,
        }
    )

    ratio_summary = {
        "normal_kind_count": len(normal_rows),
        "high_failure_kind_count": len(high_rows),
        "normal_total_kind_remapped_rows": int_sum(normal_rows),
        "high_failure_total_kind_remapped_rows": int_sum(high_rows),
        "normal_total_kind_remap_distance": int_sum(normal_distance),
        "high_failure_total_kind_remap_distance": int_sum(high_distance),
        "high_failure_norm_remapped_rows": int(high_rows.get("norm", 0)),
        "high_failure_norm_remap_distance": int(high_distance.get("norm", 0)),
        "high_failure_attn_qkv_remapped_rows": int(high_rows.get("attn_qkv_proj", 0)),
        "high_failure_attn_qkv_remap_distance": int(high_distance.get("attn_qkv_proj", 0)),
        "high_failure_mlp_down_remap_distance": int(high_distance.get("mlp_down_proj", 0)),
        "high_vs_normal_kind_count_ratio": len(high_rows) / max(1, len(normal_rows)),
        "high_vs_normal_remapped_row_ratio": int_sum(high_rows) / max(1, int_sum(normal_rows)),
        "high_vs_normal_remap_distance_ratio": int_sum(high_distance)
        / max(1, int_sum(normal_distance)),
    }
    ratios_ok = (
        ratio_summary["high_vs_normal_kind_count_ratio"] == 1.6
        and ratio_summary["high_vs_normal_remapped_row_ratio"] > 17.0
        and ratio_summary["high_vs_normal_remap_distance_ratio"] > 15.0
    )
    status, detail = pass_fail(
        ratios_ok,
        "high-failure per-kind remap spread is materially larger than normal repair",
        "high-vs-normal per-kind route-cost ratios changed",
    )
    checks.append(
        {"id": "e1x_full_k_repair_route_cost_by_kind_ratios", "status": status, "detail": detail}
    )

    failures = [check for check in checks if check["status"] != "pass"]
    kind_route_cost = {
        "normal_kind_remapped_rows": normal_rows,
        "normal_kind_total_remap_manhattan_distance": normal_distance,
        "high_failure_kind_remapped_rows": high_rows,
        "high_failure_kind_total_remap_manhattan_distance": high_distance,
    }
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        **ratio_summary,
        "kind_route_cost_summary_sha256": canonical_sha256(kind_route_cost),
        "kind_route_cost": kind_route_cost,
        "residual_blocker": "full_output_real_weight_checksum_missing",
    }
    report: dict[str, Any] = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-full-k-repair-route-cost-by-kind",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Kind-level route-cost audit for the hyper-dense full-K selected rows. "
            "It proves aggregate remap displacement is attributable to explicit "
            "layer kinds under normal and high-failure repair. This is not "
            "physical routing signoff, silicon evidence, or a full-output "
            "real-weight checksum."
        ),
        "evidence_paths": [
            "build/reports/e1x_full_k_repair_route_cost.json",
            "build/reports/e1x_full_k_repair_kind_coverage.json",
            "scripts/check_e1x_full_k_repair_route_cost_by_kind.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    report.update(FALSE_CLAIM_FLAGS)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print(
            "BLOCKED: E1X full-K repair route cost by kind failed: "
            + ", ".join(check["id"] for check in failures)
        )
        return 1
    print(f"PASS: E1X full-K repair route cost by kind; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
