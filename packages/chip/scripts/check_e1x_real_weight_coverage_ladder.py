#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_real_weight_coverage_ladder.json"

FULL_OUTPUT_WORKPLAN = ROOT / "build/reports/e1x_full_output_workplan.json"
FULL_NORM_REAL_WEIGHT = ROOT / "build/reports/e1x_full_norm_real_weight_rows.json"
VOCAB_SAMPLED_K_REAL_WEIGHT = ROOT / "build/reports/e1x_vocab_sampled_k_real_weight_rows.json"
ATTN_OUT_SAMPLED_K_REAL_WEIGHT = ROOT / "build/reports/e1x_attn_out_sampled_k_real_weight_rows.json"
ATTN_QKV_SAMPLED_K_REAL_WEIGHT = ROOT / "build/reports/e1x_attn_qkv_sampled_k_real_weight_rows.json"
MLP_GATE_SAMPLED_K_REAL_WEIGHT = ROOT / "build/reports/e1x_mlp_gate_sampled_k_real_weight_rows.json"
MLP_UP_SAMPLED_K_REAL_WEIGHT = ROOT / "build/reports/e1x_mlp_up_sampled_k_real_weight_rows.json"
MLP_DOWN_SAMPLED_K_REAL_WEIGHT = ROOT / "build/reports/e1x_mlp_down_sampled_k_real_weight_rows.json"
REPAIRED_REAL_WEIGHT = ROOT / "build/reports/e1x_repaired_real_weight_execution.json"

EXPECTED_WORKPLAN_SHA256 = "ce900472ec1f82ecc128179c77d4a04f09bbff546dc3dfbfbe36e34d018558e2"

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


def main() -> int:
    checks: list[dict[str, str]] = []
    paths = {
        "full_output_workplan": FULL_OUTPUT_WORKPLAN,
        "full_norm_real_weight": FULL_NORM_REAL_WEIGHT,
        "vocab_sampled_k_real_weight": VOCAB_SAMPLED_K_REAL_WEIGHT,
        "attn_out_sampled_k_real_weight": ATTN_OUT_SAMPLED_K_REAL_WEIGHT,
        "attn_qkv_sampled_k_real_weight": ATTN_QKV_SAMPLED_K_REAL_WEIGHT,
        "mlp_gate_sampled_k_real_weight": MLP_GATE_SAMPLED_K_REAL_WEIGHT,
        "mlp_up_sampled_k_real_weight": MLP_UP_SAMPLED_K_REAL_WEIGHT,
        "mlp_down_sampled_k_real_weight": MLP_DOWN_SAMPLED_K_REAL_WEIGHT,
        "repaired_real_weight": REPAIRED_REAL_WEIGHT,
    }
    missing = [str(path.relative_to(ROOT)) for path in paths.values() if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "real-weight coverage ladder inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append(
        {"id": "e1x_real_weight_coverage_ladder_inputs_present", "status": status, "detail": detail}
    )

    reports = {name: load_json(path) if path.is_file() else {} for name, path in paths.items()}
    workplan = reports["full_output_workplan"].get("summary", {})
    full_rows = int(workplan.get("full_output_row_count", 0))
    full_macs = int(workplan.get("full_mac_count", 0))

    components: list[dict[str, Any]] = [
        {
            "name": "full_norm",
            "layer_kind": "norm",
            "layer_count": int(
                reports["full_norm_real_weight"]
                .get("summary", {})
                .get("executed_norm_layer_count", 0)
            ),
            "row_count": int(
                reports["full_norm_real_weight"]
                .get("summary", {})
                .get("executed_norm_output_row_count", 0)
            ),
            "executed_mac_count": int(
                reports["full_norm_real_weight"]
                .get("summary", {})
                .get("executed_norm_mac_count", 0)
            ),
            "represented_full_k_mac_count": int(
                reports["full_norm_real_weight"]
                .get("summary", {})
                .get("executed_norm_mac_count", 0)
            ),
            "sampled_k": 1,
        },
        {
            "name": "vocab_sampled_k",
            "layer_kind": "embedding+lm_head",
            "layer_count": int(
                reports["vocab_sampled_k_real_weight"]
                .get("summary", {})
                .get("executed_layer_count", 0)
            ),
            "row_count": int(
                reports["vocab_sampled_k_real_weight"]
                .get("summary", {})
                .get("executed_vocab_output_row_count", 0)
            ),
            "executed_mac_count": int(
                reports["vocab_sampled_k_real_weight"]
                .get("summary", {})
                .get("executed_vocab_sampled_k_mac_count", 0)
            ),
            "represented_full_k_mac_count": int(
                reports["vocab_sampled_k_real_weight"]
                .get("summary", {})
                .get("represented_vocab_full_k_mac_count", 0)
            ),
            "sampled_k": int(
                reports["vocab_sampled_k_real_weight"].get("summary", {}).get("sampled_k", 0)
            ),
        },
        {
            "name": "attn_out_sampled_k",
            "layer_kind": "attn_out_proj",
            "layer_count": int(
                reports["attn_out_sampled_k_real_weight"]
                .get("summary", {})
                .get("executed_layer_count", 0)
            ),
            "row_count": int(
                reports["attn_out_sampled_k_real_weight"]
                .get("summary", {})
                .get("executed_attn_out_output_row_count", 0)
            ),
            "executed_mac_count": int(
                reports["attn_out_sampled_k_real_weight"]
                .get("summary", {})
                .get("executed_attn_out_sampled_k_mac_count", 0)
            ),
            "represented_full_k_mac_count": int(
                reports["attn_out_sampled_k_real_weight"]
                .get("summary", {})
                .get("represented_attn_out_full_k_mac_count", 0)
            ),
            "sampled_k": int(
                reports["attn_out_sampled_k_real_weight"].get("summary", {}).get("sampled_k", 0)
            ),
        },
        {
            "name": "attn_qkv_sampled_k",
            "layer_kind": "attn_qkv_proj",
            "layer_count": int(
                reports["attn_qkv_sampled_k_real_weight"]
                .get("summary", {})
                .get("executed_layer_count", 0)
            ),
            "row_count": int(
                reports["attn_qkv_sampled_k_real_weight"]
                .get("summary", {})
                .get("executed_attn_qkv_output_row_count", 0)
            ),
            "executed_mac_count": int(
                reports["attn_qkv_sampled_k_real_weight"]
                .get("summary", {})
                .get("executed_attn_qkv_sampled_k_mac_count", 0)
            ),
            "represented_full_k_mac_count": int(
                reports["attn_qkv_sampled_k_real_weight"]
                .get("summary", {})
                .get("represented_attn_qkv_full_k_mac_count", 0)
            ),
            "sampled_k": int(
                reports["attn_qkv_sampled_k_real_weight"].get("summary", {}).get("sampled_k", 0)
            ),
        },
        {
            "name": "mlp_gate_sampled_k",
            "layer_kind": "mlp_gate_proj",
            "layer_count": int(
                reports["mlp_gate_sampled_k_real_weight"]
                .get("summary", {})
                .get("executed_layer_count", 0)
            ),
            "row_count": int(
                reports["mlp_gate_sampled_k_real_weight"]
                .get("summary", {})
                .get("executed_mlp_gate_output_row_count", 0)
            ),
            "executed_mac_count": int(
                reports["mlp_gate_sampled_k_real_weight"]
                .get("summary", {})
                .get("executed_mlp_gate_sampled_k_mac_count", 0)
            ),
            "represented_full_k_mac_count": int(
                reports["mlp_gate_sampled_k_real_weight"]
                .get("summary", {})
                .get("represented_mlp_gate_full_k_mac_count", 0)
            ),
            "sampled_k": int(
                reports["mlp_gate_sampled_k_real_weight"].get("summary", {}).get("sampled_k", 0)
            ),
        },
        {
            "name": "mlp_up_sampled_k",
            "layer_kind": "mlp_up_proj",
            "layer_count": int(
                reports["mlp_up_sampled_k_real_weight"]
                .get("summary", {})
                .get("executed_layer_count", 0)
            ),
            "row_count": int(
                reports["mlp_up_sampled_k_real_weight"]
                .get("summary", {})
                .get("executed_mlp_up_output_row_count", 0)
            ),
            "executed_mac_count": int(
                reports["mlp_up_sampled_k_real_weight"]
                .get("summary", {})
                .get("executed_mlp_up_sampled_k_mac_count", 0)
            ),
            "represented_full_k_mac_count": int(
                reports["mlp_up_sampled_k_real_weight"]
                .get("summary", {})
                .get("represented_mlp_up_full_k_mac_count", 0)
            ),
            "sampled_k": int(
                reports["mlp_up_sampled_k_real_weight"].get("summary", {}).get("sampled_k", 0)
            ),
        },
        {
            "name": "mlp_down_sampled_k",
            "layer_kind": "mlp_down_proj",
            "layer_count": int(
                reports["mlp_down_sampled_k_real_weight"]
                .get("summary", {})
                .get("executed_layer_count", 0)
            ),
            "row_count": int(
                reports["mlp_down_sampled_k_real_weight"]
                .get("summary", {})
                .get("executed_mlp_down_output_row_count", 0)
            ),
            "executed_mac_count": int(
                reports["mlp_down_sampled_k_real_weight"]
                .get("summary", {})
                .get("executed_mlp_down_sampled_k_mac_count", 0)
            ),
            "represented_full_k_mac_count": int(
                reports["mlp_down_sampled_k_real_weight"]
                .get("summary", {})
                .get("represented_mlp_down_full_k_mac_count", 0)
            ),
            "sampled_k": int(
                reports["mlp_down_sampled_k_real_weight"].get("summary", {}).get("sampled_k", 0)
            ),
        },
    ]

    deps_ok = (
        reports["full_output_workplan"].get("status") == "PASS"
        and workplan.get("workplan_sha256") == EXPECTED_WORKPLAN_SHA256
        and all(
            reports[name].get("status") == "PASS"
            for name in reports
            if name != "full_output_workplan"
        )
        and all(
            str(report.get("summary", {}).get("residual_blocker", "")).endswith(
                "real_weight_checksum_missing"
            )
            or name == "full_output_workplan"
            for name, report in reports.items()
            if name != "repaired_real_weight"
        )
    )
    status, detail = pass_fail(
        deps_ok,
        "full-output workplan and all current real-weight row evidence reports are PASS",
        "real-weight coverage ladder dependency mismatch",
    )
    checks.append(
        {
            "id": "e1x_real_weight_coverage_ladder_dependencies_pass",
            "status": status,
            "detail": detail,
        }
    )

    total_layers = sum(int(component["layer_count"]) for component in components)
    represented_rows = sum(int(component["row_count"]) for component in components)
    executed_macs = sum(int(component["executed_mac_count"]) for component in components)
    represented_full_k_macs = sum(
        int(component["represented_full_k_mac_count"]) for component in components
    )
    row_fraction = represented_rows / full_rows if full_rows else 0.0
    executed_mac_fraction = executed_macs / full_macs if full_macs else 0.0
    represented_mac_fraction = represented_full_k_macs / full_macs if full_macs else 0.0
    missing_full_k_macs = max(0, represented_full_k_macs - executed_macs)
    repaired = reports["repaired_real_weight"].get("summary", {})

    coverage_ok = (
        total_layers == 283
        and represented_rows == full_rows == 2_608_640
        and represented_full_k_macs == full_macs == 13_015_864_320
        and executed_macs == 83_317_760
        and 0.006 < executed_mac_fraction < 0.007
        and row_fraction == 1.0
        and represented_mac_fraction == 1.0
        and int(repaired.get("executed_real_weight_row_count", 0)) == represented_rows
        and int(repaired.get("executed_real_weight_mac_count", 0)) == executed_macs
    )
    status, detail = pass_fail(
        coverage_ok,
        "current real-weight gates represent every scheduled output row and full-K MAC identity while executing bounded K",
        "real-weight coverage totals mismatch",
    )
    checks.append(
        {
            "id": "e1x_real_weight_coverage_ladder_all_rows_represented",
            "status": status,
            "detail": detail,
        }
    )

    blocker_ok = missing_full_k_macs == 12_932_546_560 and all(
        int(component["sampled_k"]) > 0 for component in components
    )
    status, detail = pass_fail(
        blocker_ok,
        "coverage ladder preserves missing full-K/full-output real-weight checksum blocker",
        "real-weight coverage blocker boundary mismatch",
    )
    checks.append(
        {
            "id": "e1x_real_weight_coverage_ladder_preserves_full_k_blocker",
            "status": status,
            "detail": detail,
        }
    )

    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "component_count": len(components),
        "represented_layer_count": total_layers,
        "represented_output_row_count": represented_rows,
        "full_output_row_count": full_rows,
        "represented_row_coverage_fraction": row_fraction,
        "executed_real_weight_mac_count": executed_macs,
        "represented_full_k_mac_count": represented_full_k_macs,
        "full_mac_count": full_macs,
        "executed_mac_coverage_fraction": executed_mac_fraction,
        "represented_full_k_mac_fraction": represented_mac_fraction,
        "missing_full_k_real_weight_mac_count": missing_full_k_macs,
        "repaired_touched_logical_core_count": int(repaired.get("touched_logical_core_count", 0)),
        "repaired_high_failure_remapped_rows": int(
            repaired.get("high_failure_touched_remapped_rows", 0)
        ),
        "coverage_components_sha256": canonical_sha256(components),
        "workplan_sha256": str(workplan.get("workplan_sha256", "")),
        "components": components,
        "residual_blocker": "full_output_real_weight_checksum_missing",
    }
    report: dict[str, Any] = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-real-weight-coverage-ladder",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Accounting gate for current deterministic W4A8 real-weight evidence. "
            "The component row gates now cover every scheduled output row and every "
            "full-K MAC identity, but most matmul classes execute only bounded sampled "
            "K windows. This is not a full-K/full-output real-weight checksum and not "
            "silicon evidence."
        ),
        "evidence_paths": [
            "build/reports/e1x_full_output_workplan.json",
            "build/reports/e1x_full_norm_real_weight_rows.json",
            "build/reports/e1x_vocab_sampled_k_real_weight_rows.json",
            "build/reports/e1x_attn_out_sampled_k_real_weight_rows.json",
            "build/reports/e1x_attn_qkv_sampled_k_real_weight_rows.json",
            "build/reports/e1x_mlp_gate_sampled_k_real_weight_rows.json",
            "build/reports/e1x_mlp_up_sampled_k_real_weight_rows.json",
            "build/reports/e1x_mlp_down_sampled_k_real_weight_rows.json",
            "build/reports/e1x_repaired_real_weight_execution.json",
            "scripts/check_e1x_real_weight_coverage_ladder.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    report.update(FALSE_CLAIM_FLAGS)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print(
            "BLOCKED: E1X real-weight coverage ladder failed: "
            + ", ".join(c["id"] for c in failures)
        )
        return 1
    print(f"PASS: E1X real-weight coverage ladder; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
