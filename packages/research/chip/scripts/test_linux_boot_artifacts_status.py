#!/usr/bin/env python3
"""Tests for scripts/check_linux_boot_artifacts.py."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import check_linux_boot_artifacts as check


class LinuxBootArtifactsStatusTests(unittest.TestCase):
    def test_manifest_claim_flags_are_required_and_reported(self) -> None:
        manifest = json.loads(check.MANIFEST.read_text(encoding="utf-8"))
        flags = {flag: manifest.get(flag) for flag in check.FALSE_CLAIM_FLAGS}
        self.assertEqual(flags, {flag: False for flag in check.FALSE_CLAIM_FLAGS})

        with mock.patch.object(check, "payload_locator_status", return_value={"state": "pass"}):
            report = check.build_report()

        for flag in check.FALSE_CLAIM_FLAGS:
            self.assertIs(report[flag], False)

    def test_structured_findings_cover_preflight_payload_and_artifacts(self) -> None:
        findings = check.structured_findings(
            [
                {
                    "id": "external_linux_tree",
                    "state": "blocked",
                    "problems": ["ELIZA_LINUX_TREE is unset"],
                }
            ],
            {
                "state": "blocked",
                "report": "build/chipyard/eliza_rocket/chipyard-linux-payload.json",
                "problems": ["no runnable payload found"],
                "selected_payload": "external/chipyard/software/firemarshal/images/firechip/eliza-e1-linux-smoke/eliza-e1-linux-smoke-bin-nodisk",
            },
            [
                {
                    "id": "serial_boot_log",
                    "path": "docs/evidence/linux/eliza_e1_serial_boot.log",
                    "state": "missing",
                    "unblock_command": "run smoke",
                    "problems": [],
                },
                {
                    "id": "dtb_check",
                    "path": "docs/evidence/linux/eliza_e1_dtb_check.log",
                    "state": "invalid",
                    "unblock_command": "run dtbs_check",
                    "problems": ["missing required markers: eliza,e1-npu"],
                },
            ],
        )
        codes = {item["code"] for item in findings}
        self.assertIn("linux_boot_preflight_external_linux_tree_eliza_linux_tree_is_unset", codes)
        self.assertIn("linux_boot_payload_no_runnable_payload_found", codes)
        self.assertIn("linux_boot_artifact_missing_serial_boot_log", codes)
        self.assertIn(
            "linux_boot_artifact_invalid_dtb_check_missing_required_markers_eliza_e1_npu",
            codes,
        )
        serial_finding = next(
            item
            for item in findings
            if item["code"] == "linux_boot_artifact_missing_serial_boot_log"
        )
        self.assertIn(
            "CHIPYARD_LINUX_BINARY=external/chipyard/software/firemarshal/images/firechip/eliza-e1-linux-smoke/eliza-e1-linux-smoke-bin-nodisk",
            serial_finding["next_command"],
        )
        self.assertNotIn("<selected_payload>", serial_finding["next_command"])

    def test_local_serial_candidates_are_reported_but_not_substituted(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            transcript = tmp / "docs/evidence/cpu_ap/linux_userland_final.transcript"
            transcript.parent.mkdir(parents=True)
            transcript.write_text(
                "\n".join(
                    [
                        "OpenSBI v1.8.1",
                        "[    0.000000] Linux version 6.12.90",
                        "[    0.000000] Kernel command line: console=ttyS0",
                        "[    0.125366] Run /init as init process",
                    ]
                ),
                encoding="utf-8",
            )
            with mock.patch.object(check, "ROOT", tmp):
                candidates = check.local_serial_candidate_transcripts()
                findings = check.structured_findings(
                    [],
                    {"state": "pass", "problems": []},
                    [
                        {
                            "id": "serial_boot_log",
                            "path": "docs/evidence/linux/eliza_e1_serial_boot.log",
                            "state": "missing",
                            "unblock_command": "run smoke",
                            "problems": [],
                        }
                    ],
                    candidates,
                )

        self.assertEqual(len(candidates), 1)
        self.assertFalse(candidates[0]["satisfies_serial_boot_artifact"])
        self.assertIn("local non-substitutable boot transcript candidates", findings[0]["message"])

    def test_artifact_specs_render_exact_located_serial_payload_command(self) -> None:
        specs = [
            {
                "id": "serial_boot_log",
                "path": "docs/evidence/linux/eliza_e1_serial_boot.log",
                "producer": "CHIPYARD_LINUX_BINARY=<selected_payload> scripts/run_chipyard_eliza_linux_smoke.sh",
                "unblock_command": "CHIPYARD_LINUX_BINARY=<selected_payload> scripts/run_chipyard_eliza_linux_smoke.sh",
            }
        ]
        updated = check.artifact_specs_with_located_payload(
            specs,
            {
                "selected_payload": "external/chipyard/software/firemarshal/images/firechip/eliza-e1-linux-smoke/eliza-e1-linux-smoke-bin-nodisk"
            },
        )

        self.assertIn(
            "CHIPYARD_LINUX_BINARY=external/chipyard/software/firemarshal/images/firechip/eliza-e1-linux-smoke/eliza-e1-linux-smoke-bin-nodisk",
            updated[0]["unblock_command"],
        )
        self.assertNotIn("<selected_payload>", updated[0]["unblock_command"])

    def test_external_preflight_blocks_even_when_artifacts_pass(self) -> None:
        preflight = [
            {
                "id": "external_linux_tree",
                "state": "blocked",
                "problems": ["ELIZA_LINUX_TREE is unset"],
            }
        ]
        artifacts = [
            {"id": "kernel_build", "state": "pass"},
            {"id": "serial_boot_log", "state": "pass"},
        ]

        self.assertTrue(check.preflight_is_release_blocking(preflight, artifacts))
        codes = {
            item["code"]
            for item in check.structured_findings(
                preflight, {"state": "pass", "problems": []}, artifacts
            )
        }
        self.assertIn("linux_boot_preflight_external_linux_tree_eliza_linux_tree_is_unset", codes)

    def test_external_preflight_blocks_when_artifacts_are_missing(self) -> None:
        preflight = [
            {
                "id": "external_linux_tree",
                "state": "blocked",
                "problems": ["ELIZA_LINUX_TREE is unset"],
            }
        ]
        artifacts = [
            {"id": "kernel_build", "state": "pass"},
            {"id": "serial_boot_log", "state": "missing", "problems": []},
        ]

        self.assertTrue(check.preflight_is_release_blocking(preflight, artifacts))
        codes = {
            item["code"]
            for item in check.structured_findings(
                preflight, {"state": "pass", "problems": []}, artifacts
            )
        }
        self.assertIn("linux_boot_preflight_external_linux_tree_eliza_linux_tree_is_unset", codes)

    def test_payload_locator_only_blocks_when_serial_artifact_not_passed(self) -> None:
        payload_locator = {
            "state": "blocked",
            "report": "build/chipyard/eliza_rocket/chipyard-linux-payload.json",
            "problems": ["no runnable payload found"],
        }

        self.assertFalse(
            check.payload_locator_is_release_blocking(
                payload_locator, [{"id": "serial_boot_log", "state": "pass"}]
            )
        )
        self.assertTrue(
            check.payload_locator_is_release_blocking(
                payload_locator, [{"id": "serial_boot_log", "state": "missing"}]
            )
        )


if __name__ == "__main__":
    unittest.main()
