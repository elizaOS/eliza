#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_full_output_checksum_manifest.json"

FULL_OUTPUT_WORKPLAN = ROOT / "build/reports/e1x_full_output_workplan.json"
TENSOR_OUTPUT = ROOT / "build/reports/e1x_tensor_output_checksum.json"
FULL_OUTPUT_COVERAGE = ROOT / "build/reports/e1x_full_output_coverage.json"
EXECUTION_LADDER = ROOT / "build/reports/e1x_execution_coverage_ladder.json"
FULL_PAYLOAD_REPAIRED_RUN = ROOT / "build/reports/e1x_full_payload_repaired_run.json"

EXPECTED_WORKPLAN_SHA256 = "ce900472ec1f82ecc128179c77d4a04f09bbff546dc3dfbfbe36e34d018558e2"
EXPECTED_SAMPLED_OUTPUT_CHECKSUM = 14_414_877_542_268_347_137
EXPECTED_ROUTED_WINDOW_CHECKSUM = 4_718_384_912_712_357_942
EXPECTED_NORMAL_TRACE_OUTPUT_CHECKSUM = 8_263_636_289_739_888_019
EXPECTED_HIGH_FAILURE_TRACE_OUTPUT_CHECKSUM = 3_419_781_716_949_080_192
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


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def canonical_sha256(data: object) -> str:
    encoded = json.dumps(data, sort_keys=True, separators=(",", ":")).encode()
    return sha256(encoded).hexdigest()


def mix64(checksum: int, value: int) -> int:
    return ((checksum ^ (value & MASK64)) * FNV64_PRIME) & MASK64


def row_commitment(record: dict, row: int) -> int:
    checksum = FNV64_OFFSET
    checksum = mix64(checksum, int(record["layer_index"]))
    checksum = mix64(checksum, row)
    checksum = mix64(checksum, int(record["routing_color"]))
    checksum = mix64(checksum, int(record["rows"]))
    checksum = mix64(checksum, int(record["cols"]))
    checksum = mix64(checksum, int(record["assigned_cores"]))
    checksum = mix64(checksum, int(record["k_wave_count"]))
    checksum = mix64(checksum, int(record["vector_word_ops"]))
    checksum = mix64(checksum, int(record["macs"]))
    return checksum


def build_manifest(records: list[dict]) -> tuple[list[dict], int, int]:
    layer_commitments: list[dict] = []
    manifest_checksum = FNV64_OFFSET
    probe_count = 0
    for record in records:
        rows = int(record["rows"])
        layer_checksum = FNV64_OFFSET
        for row in range(rows):
            commitment = row_commitment(record, row)
            layer_checksum = mix64(layer_checksum, commitment)
        manifest_checksum = mix64(manifest_checksum, int(record["layer_index"]))
        manifest_checksum = mix64(manifest_checksum, layer_checksum)

        probe_rows = sorted({0, rows // 2, rows - 1}) if rows > 0 else []
        probes = [
            {
                "output_row": row,
                "row_identity_checksum": row_commitment(record, row),
            }
            for row in probe_rows
        ]
        probe_count += len(probes)
        layer_commitments.append(
            {
                "layer_index": int(record["layer_index"]),
                "layer_name": str(record["layer_name"]),
                "kind": str(record["kind"]),
                "routing_color": int(record["routing_color"]),
                "rows": rows,
                "cols": int(record["cols"]),
                "vector_word_ops": int(record["vector_word_ops"]),
                "macs": int(record["macs"]),
                "row_identity_checksum": layer_checksum,
                "row_identity_probes": probes,
            }
        )
    return layer_commitments, manifest_checksum, probe_count


def main() -> int:
    checks: list[dict[str, str]] = []
    paths = (
        FULL_OUTPUT_WORKPLAN,
        TENSOR_OUTPUT,
        FULL_OUTPUT_COVERAGE,
        EXECUTION_LADDER,
        FULL_PAYLOAD_REPAIRED_RUN,
    )
    missing = [str(path.relative_to(ROOT)) for path in paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "full-output checksum-manifest inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append(
        {
            "id": "e1x_full_output_checksum_manifest_inputs_present",
            "status": status,
            "detail": detail,
        }
    )

    workplan = load_json(FULL_OUTPUT_WORKPLAN) if FULL_OUTPUT_WORKPLAN.is_file() else {}
    tensor_output = load_json(TENSOR_OUTPUT) if TENSOR_OUTPUT.is_file() else {}
    coverage = load_json(FULL_OUTPUT_COVERAGE) if FULL_OUTPUT_COVERAGE.is_file() else {}
    execution_ladder = load_json(EXECUTION_LADDER) if EXECUTION_LADDER.is_file() else {}
    repaired_run = (
        load_json(FULL_PAYLOAD_REPAIRED_RUN) if FULL_PAYLOAD_REPAIRED_RUN.is_file() else {}
    )

    deps_ok = (
        workplan.get("status") == "PASS"
        and tensor_output.get("status") == "PASS"
        and coverage.get("status") == "PASS"
        and execution_ladder.get("status") == "PASS"
        and repaired_run.get("status") == "PASS"
    )
    status, detail = pass_fail(
        deps_ok,
        "workplan, sampled checksum, coverage, ladder, and repaired-run reports are PASS",
        "checksum-manifest dependency report missing or failing",
    )
    checks.append(
        {
            "id": "e1x_full_output_checksum_manifest_dependencies_pass",
            "status": status,
            "detail": detail,
        }
    )

    workplan_summary = workplan.get("summary", {})
    output_summary = tensor_output.get("summary", {})
    coverage_summary = coverage.get("summary", {})
    ladder_summary = execution_ladder.get("summary", {})
    repaired_summary = repaired_run.get("summary", {})
    records = [
        record
        for record in workplan_summary.get("all_workplan_records", [])
        if isinstance(record, dict)
    ]
    layer_commitments, row_manifest_checksum, row_probe_count = build_manifest(records)
    layer_commitment_sha256 = canonical_sha256(layer_commitments)
    sampled_layer_commitments = layer_commitments[:8]

    total_rows = sum(int(record.get("rows", 0)) for record in records)
    total_macs = sum(int(record.get("macs", 0)) for record in records)
    total_vector_word_ops = sum(int(record.get("vector_word_ops", 0)) for record in records)
    workplan_ok = (
        len(records) == 283
        and total_rows == 2_608_640
        and total_macs == 13_015_864_320
        and total_vector_word_ops == 1_627_345_920
        and workplan_summary.get("workplan_sha256") == EXPECTED_WORKPLAN_SHA256
        and row_probe_count == 849
        and row_manifest_checksum > 0
    )
    status, detail = pass_fail(
        workplan_ok,
        f"checksum manifest commits {total_rows} scheduled row identities across {len(records)} layers",
        "checksum-manifest row identity accounting mismatch",
    )
    checks.append(
        {"id": "e1x_full_output_checksum_manifest_commits_rows", "status": status, "detail": detail}
    )

    checksum_links_ok = (
        int(output_summary.get("sampled_output_checksum", 0)) == EXPECTED_SAMPLED_OUTPUT_CHECKSUM
        and int(ladder_summary.get("routed_window_checksum", 0)) == EXPECTED_ROUTED_WINDOW_CHECKSUM
        and int(output_summary.get("normal_trace_output_checksum", 0))
        == EXPECTED_NORMAL_TRACE_OUTPUT_CHECKSUM
        and int(output_summary.get("high_failure_trace_output_checksum", 0))
        == EXPECTED_HIGH_FAILURE_TRACE_OUTPUT_CHECKSUM
        and int(repaired_summary.get("normal_output_checksum", 0))
        == int(output_summary.get("normal_trace_output_checksum", -1))
        and int(repaired_summary.get("high_failure_output_checksum", 0))
        == int(output_summary.get("high_failure_trace_output_checksum", -1))
    )
    status, detail = pass_fail(
        checksum_links_ok,
        "checksum manifest links sampled output, routed-window, and normal/high repaired-run checksums",
        "checksum-manifest checksum linkage mismatch",
    )
    checks.append(
        {
            "id": "e1x_full_output_checksum_manifest_links_checksums",
            "status": status,
            "detail": detail,
        }
    )

    blocker_ok = (
        int(coverage_summary.get("missing_output_row_count", 0)) == 2_607_508
        and int(coverage_summary.get("missing_mac_count", 0)) == 13_015_838_140
        and float(coverage_summary.get("output_row_coverage_fraction", 0.0)) < 0.001
        and int(ladder_summary.get("deterministic_window_remaining_row_count", -1)) == 0
        and repaired_summary.get("residual_blocker") == "full_output_real_weight_checksum_missing"
    )
    status, detail = pass_fail(
        blocker_ok,
        "manifest preserves the real-weight full-output checksum blocker",
        "checksum-manifest blocker boundary mismatch",
    )
    checks.append(
        {
            "id": "e1x_full_output_checksum_manifest_preserves_blocker",
            "status": status,
            "detail": detail,
        }
    )

    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "committed_layer_count": len(records),
        "committed_output_row_count": total_rows,
        "committed_mac_count": total_macs,
        "committed_vector_word_op_count": total_vector_word_ops,
        "committed_row_probe_count": row_probe_count,
        "row_identity_manifest_checksum": int(row_manifest_checksum),
        "layer_commitment_sha256": layer_commitment_sha256,
        "sampled_output_checksum": int(output_summary.get("sampled_output_checksum", 0)),
        "routed_window_checksum": int(ladder_summary.get("routed_window_checksum", 0)),
        "normal_trace_output_checksum": int(output_summary.get("normal_trace_output_checksum", 0)),
        "high_failure_trace_output_checksum": int(
            output_summary.get("high_failure_trace_output_checksum", 0)
        ),
        "missing_output_row_count": int(coverage_summary.get("missing_output_row_count", 0)),
        "missing_mac_count": int(coverage_summary.get("missing_mac_count", 0)),
        "real_sampled_output_row_count": int(coverage_summary.get("sampled_output_row_count", 0)),
        "workplan_sha256": str(workplan_summary.get("workplan_sha256", "")),
        "sampled_layer_commitments": sampled_layer_commitments,
        "residual_blocker": "full_output_real_weight_checksum_missing",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-full-output-checksum-manifest",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Deterministic checksum target manifest for every scheduled real-graph "
            "output row identity, linked to existing sampled-output and repaired-run "
            "checksums. This is not a full-output real-weight numerical checksum, "
            "does not execute missing rows, and does not claim silicon evidence."
        ),
        "evidence_paths": [
            "build/reports/e1x_full_output_workplan.json",
            "build/reports/e1x_tensor_output_checksum.json",
            "build/reports/e1x_full_output_coverage.json",
            "build/reports/e1x_execution_coverage_ladder.json",
            "build/reports/e1x_full_payload_repaired_run.json",
            "scripts/check_e1x_full_output_checksum_manifest.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    report.update(FALSE_CLAIM_FLAGS)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print(
            "BLOCKED: E1X full-output checksum manifest failed: "
            + ", ".join(c["id"] for c in failures)
        )
        return 1
    print(f"PASS: E1X full-output checksum manifest; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
