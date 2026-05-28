#!/usr/bin/env python3
"""Tests for e1-demo KiCad release blocker diagnostics."""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


class KicadReleaseDiagnosticsTest(unittest.TestCase):
    def test_release_report_keeps_diagnostics_out_of_release_credit(self) -> None:
        run([sys.executable, "scripts/generate_e1_demo_kicad_blocked_cli_evidence.py"])
        result = run([sys.executable, "scripts/check_kicad_artifacts.py", "--release"])
        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertIn("STATUS: BLOCKED", result.stdout)
        self.assertIn("release_credit=false", result.stdout)

        report = json.loads((ROOT / "build/reports/kicad_artifacts.json").read_text())
        self.assertEqual(report["status"], "blocked")
        self.assertFalse(report["summary"]["release_ready"])
        self.assertFalse(report["summary"]["release_credit"])
        self.assertIn("blocker_classes", report["summary"])
        self.assertGreater(
            report["summary"]["blocker_classes"]["manufacturing_manifest_release_blocker"],
            0,
        )
        self.assertGreater(
            report["summary"]["blocker_classes"]["external_approval_blocker"],
            0,
        )
        self.assertIn("tool_availability", report)
        self.assertIn("source_inventory", report)
        self.assertIn("fab_notes_inventory", report)
        self.assertIn("release_commands", report)
        self.assertIn("blocker_groups", report)
        actions = report["repo_artifact_next_actions"]
        self.assertFalse(actions["release_credit"])
        self.assertEqual(
            actions["kicad_release_command"],
            "python3 scripts/check_kicad_artifacts.py --release",
        )
        self.assertTrue(actions["blocked_manifest_lines"])
        self.assertTrue(actions["external_approval_blockers"])
        fab_notes = report["fab_notes_inventory"]
        self.assertEqual(fab_notes["status"], "fail_closed_non_release")
        self.assertFalse(fab_notes["release_credit"])
        self.assertFalse(fab_notes["fabrication_release_allowed"])
        self.assertFalse(fab_notes["missing_markers"])
        self.assertIn("foundry", fab_notes["recorded_missing_approvals"])
        promotion = report["target_status_promotion_contract"]
        self.assertFalse(promotion["release_credit"])
        self.assertEqual(promotion["status"], "blocked")
        self.assertEqual(promotion["next_action_id"], "kicad-target-promotion-001")
        self.assertIn(
            "board/kicad/e1-demo/artifact-manifest.yaml",
            promotion["source_manifests"],
        )
        self.assertIn(
            "python3 scripts/check_manufacturing_artifacts.py --manifest board/kicad/e1-demo/artifact-manifest.yaml --release",
            promotion["bounded_validation_commands"],
        )
        criteria = {item["id"]: item for item in promotion["criteria"]}
        self.assertEqual(
            criteria["kicad-promotion-001"]["field"],
            "board/kicad/e1-demo/artifact-manifest.yaml:status",
        )
        self.assertEqual(criteria["kicad-promotion-001"]["current_value"], "scaffold")
        self.assertIn("kicad-promotion-004", promotion["blocked_criteria"])
        for item in promotion["criteria"]:
            self.assertFalse(item["release_credit"])
            self.assertIn("source_manifest", item)

        for label in ("command transcript", "KiCad tool versions"):
            inventory = report["release_evidence_inventory"][label]
            self.assertTrue(inventory["paths"])
            self.assertFalse(inventory["release_credit_paths"])
            self.assertFalse(inventory["release_credit_satisfied"])
            self.assertTrue(inventory["missing_release_credit"])

        self.assertTrue(
            report["release_evidence_inventory"]["command transcript"]["diagnostic_only_paths"]
        )
        self.assertTrue(
            report["release_evidence_inventory"]["KiCad tool versions"]["diagnostic_only_paths"]
        )

        self.assertTrue(report["blocker_groups"]["release_evidence"])
        self.assertIn("toolchain", report["blocker_groups"])
        self.assertIn("non_destructive_local_unblock_commands", report["tool_availability"])
        messages = [finding["message"] for finding in report["findings"]]
        for finding in report["findings"]:
            if finding["severity"] == "blocker":
                self.assertFalse(finding["release_credit"])
                self.assertIn("blocker_class", finding)
        self.assertTrue(
            any("foundry approval" in message for message in messages),
            messages,
        )

    def test_fab_notes_record_fail_closed_non_release_status(self) -> None:
        text = (ROOT / "docs/board/kicad/e1-demo/fab-notes.md").read_text()

        for required in (
            "Release status: `blocked`",
            "Fabrication release: `prohibited`",
            "Release credit: `none`",
            "Foundry approval: `missing`",
            "Package-vendor land-pattern approval: `missing`",
            "Assembly-house DFM approval: `missing`",
        ):
            self.assertIn(required, text)

        for forbidden in (
            "fabrication-ready",
            "fabrication ready",
            "placeholder",
            "draft",
        ):
            self.assertNotIn(forbidden, text.lower())

    def test_erc_transcript_requires_release_credit_source(self) -> None:
        result = run([sys.executable, "scripts/check_kicad_artifacts.py", "--release"])
        self.assertEqual(result.returncode, 2, result.stdout)

        report = json.loads((ROOT / "build/reports/kicad_artifacts.json").read_text())
        inventory = report["release_evidence_inventory"]["erc transcript"]
        self.assertFalse(inventory["diagnostic_only_paths"])
        self.assertFalse(inventory["release_credit_paths"])
        self.assertFalse(inventory["release_credit_satisfied"])
        self.assertTrue(inventory["missing_release_credit"])

    def test_report_exposes_kicad_probe_and_release_generation_boundary(self) -> None:
        result = run([sys.executable, "scripts/check_kicad_artifacts.py", "--release"])
        self.assertEqual(result.returncode, 2, result.stdout)

        report = json.loads((ROOT / "build/reports/kicad_artifacts.json").read_text())
        tool = report["tool_availability"]
        self.assertIn("probes", tool)
        self.assertIn("partial_artifact_generation_feasible", tool)
        self.assertIn("release_artifact_generation_feasible", tool)
        self.assertFalse(tool["release_artifact_generation_feasible"])
        self.assertIsNone(tool["release_capable_source"])
        self.assertIn("non_destructive_local_unblock_commands", tool)
        for entry in report["blocker_groups"]["release_evidence"]:
            self.assertIn("generation_command", entry)

    def test_gerber_inventory_accepts_kicad_layer_extensions(self) -> None:
        gerber = ROOT / "board/reports/fab/e1-demo-2026-05-17/gerbers/e1-demo-F_Cu.gtl"
        gerber.parent.mkdir(parents=True, exist_ok=True)
        gerber.write_text("G04 KiCad test gerber*\n", encoding="utf-8")

        result = run([sys.executable, "scripts/check_kicad_artifacts.py", "--release"])
        self.assertEqual(result.returncode, 2, result.stdout)

        report = json.loads((ROOT / "build/reports/kicad_artifacts.json").read_text())
        paths = report["release_evidence_inventory"]["gerber output"]["release_credit_paths"]
        self.assertIn(
            "board/reports/fab/e1-demo-2026-05-17/gerbers/e1-demo-F_Cu.gtl",
            paths,
        )

    def test_manifest_declares_exact_fab_drawing_command(self) -> None:
        manifest = yaml.safe_load((ROOT / "board/kicad/e1-demo/artifact-manifest.yaml").read_text())
        commands = manifest["artifact_groups"]["kicad_cli_outputs"]["cli_commands"]
        self.assertIn("fab_drawing", commands)
        self.assertIn("kicad-cli pcb export pdf", commands["fab_drawing"])
        artifact_names = {
            artifact["name"]
            for artifact in manifest["artifact_groups"]["kicad_cli_outputs"]["artifacts"]
        }
        self.assertIn("fab_drawing", artifact_names)

    def test_diagnostic_generator_writes_machine_readable_non_release_inventory(self) -> None:
        result = run([sys.executable, "scripts/generate_e1_demo_kicad_blocked_cli_evidence.py"])
        self.assertEqual(result.returncode, 0, result.stdout)

        base = ROOT / "board/reports/fab/e1-demo-2026-05-17"
        transcript = base / "e1-demo-kicad-command-transcript.txt"
        tools = base / "e1-demo-kicad-tool-version.txt"
        diagnostics = base / "e1-demo-kicad-blocked-diagnostics.json"
        for path in (transcript, tools):
            self.assertTrue(path.is_file(), path)
            text = path.read_text(encoding="utf-8")
            self.assertIn("release_credit: false", text)
            self.assertIn("not", text.lower())

        payload = json.loads(diagnostics.read_text(encoding="utf-8"))
        self.assertFalse(payload["release_credit"])
        self.assertIn("source_inventory", payload)
        self.assertIn("source_manifests", payload)
        self.assertIn("commands", payload)
        self.assertIn("expected_command_outputs", payload)
        self.assertIn("target_status_promotion_contract", payload)
        self.assertFalse(payload["target_status_promotion_contract"]["release_credit"])
        self.assertIn(
            "kicad-promotion-001",
            payload["target_status_promotion_contract"]["blocked_criteria"],
        )
        outputs = {entry["label"]: entry for entry in payload["expected_command_outputs"]}
        self.assertIn("drc transcript", outputs)
        self.assertEqual(
            outputs["drc transcript"]["source_manifest"],
            "board/kicad/e1-demo/artifact-manifest.yaml",
        )
        self.assertIn(
            "**/*drc*.txt",
            outputs["drc transcript"]["expected_globs"],
        )
        self.assertFalse(outputs["drc transcript"]["release_credit"])
        command_names = {entry["name"] for entry in payload["commands"]}
        self.assertIn("fab_drawing", command_names)
        self.assertIn("fab_drawing", payload["required_release_outputs"])
        transcript_text = transcript.read_text(encoding="utf-8")
        self.assertIn("target_status_promotion_contract:", transcript_text)
        self.assertIn(
            "source_manifest: board/kicad/e1-demo/artifact-manifest.yaml", transcript_text
        )
        self.assertIn("expected_command_output:", transcript_text)


if __name__ == "__main__":
    unittest.main()
