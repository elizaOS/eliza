#!/usr/bin/env python3
"""Focused tests for PD signoff manifest validation in manufacturing gate."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from check_manufacturing_artifacts import ROOT, validate_pd_signoff_manifest


def manifest_with(**updates: object) -> dict[str, object]:
    manifest: dict[str, object] = {
        "signoff": "unit_pd",
        "status": "required_for_pd_release",
        "runner": {
            "require_pinned_runner_for_release": True,
            "openlane_image_digest": "sha256:" + "a" * 64,
        },
        "run_roots": ["pd/openlane/runs"],
        "required_artifacts": {
            "final_summary": {
                "globs": ["build/unit-pd-signoff/final/summary.rpt"],
                "min_bytes": 4,
            }
        },
        "blocked_gates": {
            "sta": {
                "blocked": True,
                "reason": "release STA evidence not archived",
            }
        },
    }
    manifest.update(dict(updates))
    return manifest


class ManufacturingPdSignoffManifestTests(unittest.TestCase):
    def test_scaffold_mode_accepts_structural_manifest_without_files(self) -> None:
        failures = validate_pd_signoff_manifest(
            ROOT / "pd/signoff/manifest.yaml",
            manifest_with(),
            release=False,
        )

        self.assertEqual(failures, [])

    def test_release_mode_fails_missing_artifact_and_blocked_gate(self) -> None:
        failures = validate_pd_signoff_manifest(
            ROOT / "pd/signoff/manifest.yaml",
            manifest_with(),
            release=True,
        )

        self.assertIn("unit_pd.final_summary: release artifact files are missing", failures)
        self.assertIn("unit_pd.blocked_gates.sta: release gate remains blocked", failures)

    def test_runner_must_be_pinned(self) -> None:
        failures = validate_pd_signoff_manifest(
            ROOT / "pd/signoff/manifest.yaml",
            manifest_with(runner={"require_pinned_runner_for_release": False}),
            release=False,
        )

        self.assertIn("unit_pd: release requires require_pinned_runner_for_release", failures)
        self.assertIn("unit_pd: missing pinned OpenLane image digest", failures)

    def test_release_mode_accepts_present_artifact_but_not_blocked_gate(self) -> None:
        with tempfile.TemporaryDirectory(dir=ROOT / "build") as tmpdir:
            artifact = Path(tmpdir) / "summary.rpt"
            artifact.write_text("ok\n", encoding="utf-8")
            pattern = artifact.relative_to(ROOT).as_posix()
            failures = validate_pd_signoff_manifest(
                ROOT / "pd/signoff/manifest.yaml",
                manifest_with(
                    required_artifacts={
                        "final_summary": {
                            "globs": [pattern],
                            "min_bytes": 2,
                        }
                    }
                ),
                release=True,
            )

        self.assertNotIn("unit_pd.final_summary: release artifact files are missing", failures)
        self.assertIn("unit_pd.blocked_gates.sta: release gate remains blocked", failures)

    def test_malformed_artifact_entry_is_reported(self) -> None:
        failures = validate_pd_signoff_manifest(
            ROOT / "pd/signoff/manifest.yaml",
            manifest_with(required_artifacts={"final_summary": "not-a-mapping"}),
            release=True,
        )

        self.assertIn("unit_pd.final_summary: artifact must be a mapping", failures)


if __name__ == "__main__":
    unittest.main()
