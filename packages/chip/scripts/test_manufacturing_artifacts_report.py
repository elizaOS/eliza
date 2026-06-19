#!/usr/bin/env python3
"""Regression tests for manufacturing artifact release blocker reporting."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/manufacturing_artifacts.json"
RESOLVED = ROOT / "build/reports/manufacturing-resolved-artifacts.json"
FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "fabrication_claim_allowed": False,
    "board_fabrication_claim_allowed": False,
    "package_vendor_approval_claim_allowed": False,
    "fpga_release_claim_allowed": False,
    "pd_signoff_claim_allowed": False,
    "tapeout_claim_allowed": False,
    "first_article_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}


def main() -> int:
    result = subprocess.run(
        [sys.executable, "scripts/check_manufacturing_artifacts.py", "--release"],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    assert result.returncode == 2, result.stdout[-4000:]
    assert "STATUS: BLOCKED manufacturing artifact release check" in result.stdout
    report = json.loads(REPORT.read_text(encoding="utf-8"))
    assert report["schema"] == "eliza.manufacturing_artifacts.v1"
    assert report["status"] == "blocked"
    for key, expected in FALSE_CLAIM_FLAGS.items():
        assert report.get(key) is expected, key
    assert report["resolved_manifest"] == "build/reports/manufacturing-resolved-artifacts.json"
    assert RESOLVED.is_file()

    summary = report["summary"]
    state_counts = summary["artifact_state_counts"]
    dependency_counts = report["blocker_dependency_counts"]
    assert dependency_counts["repo_artifact_generation"] == 0
    assert dependency_counts["live_device_validation"] == 0
    assert dependency_counts["actionable_external_dependency"] == summary["blockers"]
    assert report["blocker_dependency_summary"]["release_credit"] is False
    assert "actionable_external_dependency" in report["next_command_by_dependency"]
    assert state_counts["true_missing_generated_file"] > 0
    assert state_counts["true_missing_release_output"] > 0
    assert state_counts["present_fail_closed_non_release_artifact"] > 0
    assert summary["blocker_classes"]["missing_generated_artifact_file"] > 0
    assert summary["blocker_classes"]["present_non_release_planning_artifact"] > 0

    state_summary = report["artifact_state_summary"]
    assert state_summary["release_credit"] is False
    state_rows = {row["state"]: row for row in state_summary["states"]}
    assert "true_missing_generated_file" in state_rows
    assert "present_fail_closed_non_release_artifact" in state_rows
    assert state_rows["true_missing_generated_file"]["sample_findings"]
    assert state_rows["present_fail_closed_non_release_artifact"]["sample_findings"]
    generation_plan = state_summary["true_missing_generation_plan"]
    assert generation_plan["release_credit"] is False
    assert generation_plan["target_artifact_count"] == (
        state_counts["true_missing_generated_file"]
        + state_counts["true_missing_release_output"]
        + state_counts["true_missing_checksum_manifest"]
    )
    assert generation_plan["repo_generatable_now_count"] == 0
    assert generation_plan["blocked_generation_count"] == generation_plan["target_artifact_count"]
    assert generation_plan["generation_status_counts"]
    assert any(
        plan["generation_status"]
        == "repo_diagnostic_generator_available_but_release_output_blocked"
        and "python3 scripts/generate_e1_demo_fpga_blocked_cli_evidence.py"
        in plan["generation_commands"]
        for plan in generation_plan["plans"]
    )
    assert any(
        plan["generation_status"] == "blocked_external_vendor_or_foundry_evidence_required"
        for plan in generation_plan["plans"]
    )
    assert any(
        plan["source_selector"] == "required_release_output_manifest.routed_kicad_pcb"
        and plan["generation_status"] == "blocked_by_routed_pcb_release_gate"
        for plan in generation_plan["plans"]
    )
    assert any(
        plan["source_selector"].startswith("required_release_output_manifest.")
        and plan["artifact_state"] == "true_missing_release_output"
        and plan["generation_status"]
        in {
            "blocked_by_factory_output_release",
            "blocked_by_supplier_and_avl_release",
            "blocked_by_enclosure_and_factory_output_release",
            "blocked_by_first_article_measurements",
        }
        and "python3 scripts/check_e1_phone_factory_output_content.py"
        in plan["generation_commands"]
        for plan in generation_plan["plans"]
    )
    assert any(
        plan["source_selector"] == "required_release_output_manifest.routed_kicad_pcb"
        and plan["artifact_state"] == "true_missing_release_output"
        and plan["generation_status"] == "blocked_by_routed_pcb_release_gate"
        and "python3 scripts/check_e1_phone_routed_output_content.py" in plan["generation_commands"]
        for plan in generation_plan["plans"]
    )
    assert any(
        packet["artifact_state"]
        in {"true_missing_release_output", "present_fail_closed_non_release_artifact"}
        and packet["artifact_context"]
        .get("selector", "")
        .startswith("required_release_output_manifest.")
        and "first_article" in packet["artifact_context"].get("selector", "")
        and "python3 scripts/check_e1_phone_first_article_content.py"
        in packet["generation_commands"]
        for packet in report["blocker_execution_packets"]
    )

    matrix = report["manifest_unblock_matrix"]
    assert len(matrix) >= 5
    matrix_by_path = {row["manifest_path"]: row for row in matrix}
    pd_row = matrix_by_path["pd/signoff/manifest.yaml"]
    assert pd_row["manifest"] == "e1_chip_top_pd"
    assert pd_row["release_credit"] is False
    assert pd_row["artifact_state_counts"]["external_release_gate_open"] > 0
    assert "python3 scripts/check_pd_signoff.py" in pd_row["generation_commands"]
    assert (
        "python3 scripts/check_openlane_run_preflight.py --release" in pd_row["generation_commands"]
    )
    assert "build/reports/pd_signoff.json" in pd_row["primary_paths"]
    for row in matrix:
        assert row["release_credit"] is False
        assert row["manifest_path"]
        assert row["artifact_state_counts"]
        assert row["state_next_steps"]
        assert row["generation_commands"]
        assert all(command.startswith("python3 ") for command in row["generation_commands"])
        assert row["primary_paths"]

    packets = report["blocker_execution_packets"]
    assert packets
    for packet in packets[:20]:
        assert packet["release_credit"] is False
        assert packet["artifact_state"]
        assert packet["generation_commands"]
        assert packet["primary_paths"]
        assert "artifact_context" in packet
        assert "repo_generation_plan" in packet
    assert any(
        packet["artifact_state"] == "true_missing_generated_file"
        and packet["artifact_context"].get("files_present") is False
        for packet in packets
    )
    assert any(
        packet["artifact_state"] == "true_missing_generated_file"
        and packet["repo_generation_plan"]["can_generate_from_repo_now"] is False
        and "python3 scripts/generate_e1_demo_fpga_blocked_cli_evidence.py"
        in packet["generation_commands"]
        for packet in packets
    )
    assert any(
        packet["artifact_state"] == "present_fail_closed_non_release_artifact"
        and packet["artifact_context"].get("files_present") is True
        for packet in packets
    )
    assert any(
        packet["artifact_state"]
        in {"true_missing_release_output", "present_fail_closed_non_release_artifact"}
        and (
            packet["artifact_context"]
            .get("selector", "")
            .startswith("required_release_output_manifest.")
            or "factory" in packet["artifact_context"].get("selector", "")
        )
        and "python3 scripts/check_e1_phone_factory_output_content.py"
        in packet["generation_commands"]
        and packet["repo_generation_plan"]["can_generate_from_repo_now"] is False
        for packet in packets
    )
    assert all(
        finding["dependency_type"] == "actionable_external_dependency"
        for finding in report["findings"]
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
