#!/usr/bin/env python3
"""Regression tests for manufacturing artifact release blocker reporting."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/manufacturing_artifacts.json"
RESOLVED = ROOT / "build/reports/manufacturing-resolved-artifacts.json"


def main() -> int:
    result = subprocess.run(
        ["python3", "scripts/check_manufacturing_artifacts.py", "--release"],
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
    assert report["resolved_manifest"] == "build/reports/manufacturing-resolved-artifacts.json"
    assert RESOLVED.is_file()

    summary = report["summary"]
    state_counts = summary["artifact_state_counts"]
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

    matrix = report["manifest_unblock_matrix"]
    assert len(matrix) >= 5
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
