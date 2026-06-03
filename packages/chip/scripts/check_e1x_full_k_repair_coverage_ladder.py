#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_full_k_repair_coverage_ladder.json"

FULL_OUTPUT_WORKPLAN = ROOT / "build/reports/e1x_full_output_workplan.json"
REAL_WEIGHT_LADDER = ROOT / "build/reports/e1x_real_weight_coverage_ladder.json"
RUNG_REPORTS = [
    (
        "stratified_16",
        16,
        ROOT / "build/reports/e1x_stratified_full_k_repair_execution.json",
        "bde87dfb102b537486283d80fb831738b837fd56f332553f348beda75a132bb7",
    ),
    (
        "dense_32",
        32,
        ROOT / "build/reports/e1x_dense_stratified_full_k_repair_execution.json",
        "e6eec1eefdfbc6d2b146a5efde1c4ba149d188fa31156f3ca394674830a12768",
    ),
    (
        "ultra_dense_64",
        64,
        ROOT / "build/reports/e1x_ultra_dense_stratified_full_k_repair_execution.json",
        "549b0da412404be0f41351fa4bdb79883089306bc480515e8eb89f6467682b7d",
    ),
    (
        "hyper_dense_128",
        128,
        ROOT / "build/reports/e1x_hyper_dense_stratified_full_k_repair_execution.json",
        "31f1aa362fceff9d7f16cc13f3ab5cca1d6cfff9026b1d955f1e145443ab1c0f",
    ),
]

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


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def canonical_sha256(data: object) -> str:
    encoded = json.dumps(data, sort_keys=True, separators=(",", ":")).encode()
    return sha256(encoded).hexdigest()


def main() -> int:
    checks: list[dict[str, str]] = []
    paths = [FULL_OUTPUT_WORKPLAN, REAL_WEIGHT_LADDER] + [path for _, _, path, _ in RUNG_REPORTS]
    missing = [str(path.relative_to(ROOT)) for path in paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "full-K repair coverage ladder inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append(
        {
            "id": "e1x_full_k_repair_coverage_ladder_inputs_present",
            "status": status,
            "detail": detail,
        }
    )

    workplan = load_json(FULL_OUTPUT_WORKPLAN) if FULL_OUTPUT_WORKPLAN.is_file() else {}
    real_weight_ladder = load_json(REAL_WEIGHT_LADDER) if REAL_WEIGHT_LADDER.is_file() else {}
    full_rows = int(workplan.get("summary", {}).get("full_output_row_count", 0))
    full_macs = int(workplan.get("summary", {}).get("full_mac_count", 0))
    deps_ok = (
        workplan.get("status") == "PASS"
        and workplan.get("summary", {}).get("workplan_sha256") == EXPECTED_WORKPLAN_SHA256
        and real_weight_ladder.get("status") == "PASS"
        and real_weight_ladder.get("summary", {}).get("residual_blocker")
        == "full_output_real_weight_checksum_missing"
        and full_rows == 2_608_640
        and full_macs == 13_015_864_320
    )
    status, detail = pass_fail(
        deps_ok,
        "full-output workplan and real-weight ladder dependencies are PASS",
        "full-K repair coverage ladder dependency mismatch",
    )
    checks.append(
        {
            "id": "e1x_full_k_repair_coverage_ladder_dependencies_pass",
            "status": status,
            "detail": detail,
        }
    )

    rungs: list[dict[str, int | float | str]] = []
    for name, rows_per_layer, path, expected_sha in RUNG_REPORTS:
        report = load_json(path) if path.is_file() else {}
        summary = report.get("summary", {})
        rung = {
            "name": name,
            "rows_per_layer": rows_per_layer,
            "row_count": int(summary.get("executed_stratified_full_k_row_count", 0)),
            "mac_count": int(summary.get("executed_stratified_full_k_mac_count", 0)),
            "touched_logical_core_count": int(summary.get("touched_logical_core_count", 0)),
            "normal_touched_remapped_rows": int(summary.get("normal_touched_remapped_rows", 0)),
            "high_failure_touched_remapped_rows": int(
                summary.get("high_failure_touched_remapped_rows", 0)
            ),
            "sampled_stratified_rows_sha256": str(
                summary.get("sampled_stratified_rows_sha256", "")
            ),
            "row_coverage_fraction": (
                int(summary.get("executed_stratified_full_k_row_count", 0)) / full_rows
                if full_rows
                else 0.0
            ),
            "mac_coverage_fraction": (
                int(summary.get("executed_stratified_full_k_mac_count", 0)) / full_macs
                if full_macs
                else 0.0
            ),
        }
        rungs.append(rung)
        rung_ok = (
            report.get("status") == "PASS"
            and summary.get("residual_blocker") == "full_output_real_weight_checksum_missing"
            and rung["sampled_stratified_rows_sha256"] == expected_sha
            and int(summary.get("failing_check_count", 1)) == 0
        )
        status, detail = pass_fail(
            rung_ok,
            f"{name} repair-aware full-K rung is PASS and preserves blocker",
            f"{name} repair-aware full-K rung mismatch",
        )
        checks.append(
            {
                "id": f"e1x_full_k_repair_coverage_ladder_{name}",
                "status": status,
                "detail": detail,
            }
        )

    expected_rows = [4_528, 9_056, 18_112, 36_224]
    expected_macs = [22_119_696, 44_239_392, 88_478_784, 176_957_568]
    row_counts = [int(rung["row_count"]) for rung in rungs]
    mac_counts = [int(rung["mac_count"]) for rung in rungs]
    monotonic_ok = (
        row_counts == expected_rows
        and mac_counts == expected_macs
        and all(
            row_counts[index] == row_counts[index - 1] * 2 for index in range(1, len(row_counts))
        )
        and all(
            mac_counts[index] == mac_counts[index - 1] * 2 for index in range(1, len(mac_counts))
        )
        and all(
            int(rungs[index]["touched_logical_core_count"])
            > int(rungs[index - 1]["touched_logical_core_count"])
            for index in range(1, len(rungs))
        )
        and int(rungs[-1]["high_failure_touched_remapped_rows"]) == 760
    )
    status, detail = pass_fail(
        monotonic_ok,
        "repair-aware full-K ladder doubles row and MAC coverage at each rung",
        "repair-aware full-K coverage ladder is not monotonic",
    )
    checks.append(
        {
            "id": "e1x_full_k_repair_coverage_ladder_monotonic_gain",
            "status": status,
            "detail": detail,
        }
    )

    max_rows = row_counts[-1] if row_counts else 0
    max_macs = mac_counts[-1] if mac_counts else 0
    missing_full_k_rows = max(0, full_rows - max_rows)
    missing_full_k_macs = max(0, full_macs - max_macs)
    blocker_ok = (
        missing_full_k_rows == 2_572_416
        and missing_full_k_macs == 12_838_906_752
        and 0.013 < (max_rows / full_rows if full_rows else 0.0) < 0.014
        and 0.013 < (max_macs / full_macs if full_macs else 0.0) < 0.014
    )
    status, detail = pass_fail(
        blocker_ok,
        "ladder quantifies remaining full-output full-K real-weight checksum gap",
        "full-K repair ladder blocker boundary mismatch",
    )
    checks.append(
        {
            "id": "e1x_full_k_repair_coverage_ladder_preserves_blocker",
            "status": status,
            "detail": detail,
        }
    )

    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "rung_count": len(rungs),
        "full_output_row_count": full_rows,
        "full_mac_count": full_macs,
        "max_repaired_full_k_row_count": max_rows,
        "max_repaired_full_k_mac_count": max_macs,
        "max_repaired_full_k_row_fraction": max_rows / full_rows if full_rows else 0.0,
        "max_repaired_full_k_mac_fraction": max_macs / full_macs if full_macs else 0.0,
        "missing_full_k_output_row_count": missing_full_k_rows,
        "missing_full_k_mac_count": missing_full_k_macs,
        "row_gain_vs_first_rung": max_rows / max(1, row_counts[0]) if row_counts else 0.0,
        "mac_gain_vs_first_rung": max_macs / max(1, mac_counts[0]) if mac_counts else 0.0,
        "max_touched_logical_core_count": int(rungs[-1]["touched_logical_core_count"]),
        "max_high_failure_touched_remapped_rows": int(
            rungs[-1]["high_failure_touched_remapped_rows"]
        ),
        "rung_summary_sha256": canonical_sha256(rungs),
        "workplan_sha256": str(workplan.get("summary", {}).get("workplan_sha256", "")),
        "rungs": rungs,
        "residual_blocker": "full_output_real_weight_checksum_missing",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-full-k-repair-coverage-ladder",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Accounting gate over repair-aware deterministic W4A8 full-K evidence "
            "rungs. It proves monotonic coverage growth through 128 rows per placed "
            "layer and quantifies the remaining full-output full-K gap. This is not "
            "a full-output real-weight checksum and not silicon evidence."
        ),
        "evidence_paths": [
            "build/reports/e1x_full_output_workplan.json",
            "build/reports/e1x_real_weight_coverage_ladder.json",
            "build/reports/e1x_stratified_full_k_repair_execution.json",
            "build/reports/e1x_dense_stratified_full_k_repair_execution.json",
            "build/reports/e1x_ultra_dense_stratified_full_k_repair_execution.json",
            "build/reports/e1x_hyper_dense_stratified_full_k_repair_execution.json",
            "scripts/check_e1x_full_k_repair_coverage_ladder.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    report.update(FALSE_CLAIM_FLAGS)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print(
            "BLOCKED: E1X full-K repair coverage ladder failed: "
            + ", ".join(c["id"] for c in failures)
        )
        return 1
    print(f"PASS: E1X full-K repair coverage ladder; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
