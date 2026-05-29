#!/usr/bin/env python3
"""Tests for scripts/check_chip_os_evidence_provenance.py."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import check_chip_os_evidence_provenance as provenance


def assert_false_claim_flags(testcase: unittest.TestCase, report: dict[str, object]) -> None:
    testcase.assertEqual(report["claim_boundary"], provenance.CLAIM_BOUNDARY)
    for key, expected in provenance.FALSE_CLAIM_FLAGS.items():
        testcase.assertIs(report.get(key), expected, key)


class ChipOsEvidenceProvenanceTests(unittest.TestCase):
    def test_detects_host_path_reference_scope_and_missing_timestamp(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/demo.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "demo.v1",
                        "status": "blocked",
                        "claim_boundary": "qemu_virt_reference_only_not_chip_boot",
                        "path": "/home/shaw/demo/artifact.log",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])
        assert_false_claim_flags(self, data)
        categories = data["summary"]["categories"]
        self.assertGreaterEqual(categories["host_local_path"], 1)
        self.assertGreaterEqual(categories["weak_reference_scope"], 1)
        self.assertGreaterEqual(categories["missing_timestamp"], 1)
        self.assertGreaterEqual(categories["nonpassing_status"], 1)
        self.assertEqual(
            data["scan_root_summary"][0]["root"],
            "packages/chip/build/reports",
        )

    def test_passes_clean_timestamped_structured_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/demo.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "demo.v1",
                        "status": "pass",
                        "claim_boundary": "runtime evidence for selected chip emulator",
                        "generated_utc": "2026-05-21T00:00:00Z",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])
        self.assertEqual(data["summary"]["findings"], 0)
        self.assertEqual(data["status"], "pass")
        assert_false_claim_flags(self, data)

    def test_generated_at_utc_counts_as_timestamp_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "docs/evidence/cpu_ap/branch-prediction-params.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "eliza.bpu_params.v1",
                        "status": "clean",
                        "claim_boundary": "branch predictor parameter evidence only",
                        "generated_at_utc": "2026-05-21T00:00:00Z",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/docs/evidence"])

        self.assertEqual(data["summary"]["findings"], 0)
        self.assertEqual(data["status"], "pass")

    def test_generated_at_counts_as_timestamp_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "docs/evidence/cpu_ap/core-selection.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "eliza.cpu_ap_core_selection_evidence.v1",
                        "status": "pass",
                        "claim_boundary": "core-selection inventory evidence only",
                        "generated_at": "2026-05-21T00:00:00Z",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/docs/evidence"])

        self.assertEqual(data["summary"]["findings"], 0)
        self.assertEqual(data["status"], "pass")

    def test_as_of_counts_as_timestamp_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/e1x_dft_cocotb.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "eliza.gate_status.v1",
                        "status": "PASS",
                        "claim_boundary": "DFT cocotb evidence only",
                        "as_of": "2026-05-21T00:00:00Z",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])

        self.assertEqual(data["summary"]["findings"], 0)
        self.assertEqual(data["status"], "pass")

    def test_sanitized_host_tmp_placeholder_is_not_host_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            sanitized = root / "docs/evidence/qemu-sanitized.log"
            raw = root / "docs/evidence/qemu-raw.log"
            sanitized.parent.mkdir(parents=True)
            sanitized.write_text(
                "## generated_utc: 2026-05-21T00:00:00Z\n"
                "## claim_boundary: sanitized host placeholder transcript\n"
                "virtiofs_mount=<host-tmp>/tmp.bnFbovaV2I\n",
                encoding="utf-8",
            )
            raw.write_text(
                "## generated_utc: 2026-05-21T00:00:00Z\n"
                "## claim_boundary: raw host transcript fixture\n"
                "virtiofs_mount=/tmp/raw-host-path\n",
                encoding="utf-8",
            )

            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/docs/evidence"])

        host_findings = [
            finding
            for finding in data["findings"]
            if finding["category"] == "host_local_path"
        ]
        self.assertEqual(len(host_findings), 1)
        self.assertEqual(host_findings[0]["path"], "packages/chip/docs/evidence/qemu-raw.log")

    def test_keyword_inventory_excerpts_do_not_expand_marker_counts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/chip-os-gap-keyword-inventory.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "eliza.chip_os_gap_keyword_inventory.v1",
                        "status": "blocked",
                        "claim_boundary": "source keyword inventory only",
                        "generated_utc": "2026-05-21T00:00:00Z",
                        "findings": [
                            {
                                "description": "stub/placeholder marker",
                                "excerpt": "TODO placeholder remains blocked",
                            }
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])

        self.assertEqual(data["summary"]["findings"], 1)
        self.assertEqual(data["findings"][0]["category"], "nonpassing_status")

    def test_aggregate_reports_do_not_expand_marker_counts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/chip-os-bring-up-status.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "eliza.aggregate.v1",
                        "status": "blocked",
                        "claim_boundary": "aggregate survey only",
                        "generated_utc": "2026-05-21T00:00:00Z",
                        "gates": [
                            {
                                "status": "BLOCKED",
                                "evidence": "placeholder transcript is missing",
                            }
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])

        self.assertEqual(data["summary"]["findings"], 1)
        self.assertEqual(data["findings"][0]["category"], "nonpassing_status")

    def test_statusless_current_aggregate_reports_do_not_expand_marker_counts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/chip-tapeout-readiness-current.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "eliza.tapeout_readiness.v1",
                        "claim_boundary": "aggregate survey only",
                        "generated_utc": "2026-05-21T00:00:00Z",
                        "summary": {"blocked": 1},
                        "gates": [{"status": "BLOCKED", "evidence": "placeholder missing"}],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])

        self.assertEqual(data["summary"]["findings"], 0)

    def test_nonpassing_structured_reports_do_not_expand_marker_counts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/runtime_contract.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "demo.runtime.v1",
                        "status": "blocked",
                        "claim_boundary": "runtime evidence contract",
                        "generated_utc": "2026-05-21T00:00:00Z",
                        "findings": [
                            {
                                "message": "placeholder transcript missing",
                                "evidence": "BLOCKED until runtime capture exists",
                            }
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])

        self.assertEqual(data["summary"]["findings"], 1)
        self.assertEqual(data["findings"][0]["category"], "nonpassing_status")

    def test_typed_blocked_structured_reports_do_not_expand_marker_counts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/software_bsp_scope.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "demo.software_bsp_scope.v1",
                        "status": "software_bsp_scope_release_blocked",
                        "claim_boundary": "BSP scope audit only",
                        "generated_utc": "2026-05-21T00:00:00Z",
                        "findings": [
                            {
                                "message": "vendor transcript missing required PASS markers",
                                "evidence": "status=FAIL placeholder remains blocked",
                            }
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])

        self.assertEqual(data["summary"]["findings"], 1)
        self.assertEqual(data["findings"][0]["category"], "nonpassing_status")
        self.assertEqual(
            data["findings"][0]["code"],
            "nonpassing_status_software_bsp_scope_release_blocked",
        )

    def test_passing_structured_reports_still_scan_marker_lines(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/runtime_contract.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "demo.runtime.v1",
                        "status": "pass",
                        "claim_boundary": "runtime evidence contract",
                        "generated_utc": "2026-05-21T00:00:00Z",
                        "note": "placeholder transcript should not appear in passing evidence",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])

        self.assertEqual(data["summary"]["findings"], 1)
        self.assertEqual(data["findings"][0]["category"], "placeholder_marker")

    def test_structured_claim_boundary_is_present(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/demo.yaml"
            report.parent.mkdir(parents=True)
            report.write_text(
                "schema: demo.v1\n"
                "status: pass\n"
                "generated_utc: '2026-05-21T00:00:00Z'\n"
                "claim_boundary:\n"
                "  allowed_current_claims:\n"
                "    - scaffold only\n"
                "  blocked_claims:\n"
                "    - release evidence\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])

        self.assertEqual(data["summary"]["findings"], 0)
        self.assertEqual(data["status"], "pass")

    def test_default_roots_cover_os_android_release_and_app_payload_manifests(self) -> None:
        expected = {
            "packages/chip/build/reports",
            "packages/chip/docs/evidence",
            "packages/os/linux/elizaos/evidence",
            "packages/os/android/installer/manifests",
            "packages/os/android/vendor/eliza/manifests",
            "packages/os/release/beta-2026-05-16",
            "packages/os/release/confidential-2026-05-21",
            "packages/app/android/app/src/main/assets/agent/plugins-manifest.json",
        }
        self.assertTrue(expected.issubset(set(provenance.DEFAULT_SCAN_ROOTS)))


if __name__ == "__main__":
    unittest.main()
