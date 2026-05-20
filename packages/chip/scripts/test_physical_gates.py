#!/usr/bin/env python3
import subprocess
import sys
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


def run_check(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


class PhysicalGateTests(unittest.TestCase):
    def test_scaffold_gates_pass(self) -> None:
        commands = [
            ("scripts/check_package_cross_probe.py",),
            ("scripts/check_kicad_artifacts.py",),
            ("scripts/check_fpga_release.py",),
            ("scripts/check_openlane_run_preflight.py",),
            ("scripts/check_manufacturing_artifacts.py",),
            ("scripts/check_pd_signoff.py", "--manifest-only"),
        ]
        for command in commands:
            with self.subTest(command=" ".join(command)):
                result = run_check(*command)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_release_gates_fail_closed_without_external_artifacts(self) -> None:
        commands = [
            ("scripts/check_kicad_artifacts.py", "--release"),
            ("scripts/check_fpga_release.py", "--release"),
            ("scripts/check_openlane_run_preflight.py", "--release"),
            ("scripts/check_manufacturing_artifacts.py", "--release"),
            ("scripts/check_pd_signoff.py",),
        ]
        for command in commands:
            with self.subTest(command=" ".join(command)):
                result = run_check(*command)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_manufacturing_manifest_references_leaf_manifests(self) -> None:
        manifest = yaml.safe_load((ROOT / "docs/manufacturing/artifact-manifest.yaml").read_text())
        self.assertIsInstance(manifest, dict)
        references = set(manifest.get("artifact_manifests", []))
        self.assertIn("package/artifact-manifest.yaml", references)
        self.assertIn("board/kicad/e1-demo/artifact-manifest.yaml", references)
        self.assertIn("board/kicad/e1-phone/artifact-manifest.yaml", references)
        self.assertIn("board/fpga/artifact-manifest.yaml", references)
        self.assertIn("pd/signoff/manifest.yaml", references)

    def test_fpga_manifest_lists_cli_evidence(self) -> None:
        manifest = yaml.safe_load((ROOT / "board/fpga/artifact-manifest.yaml").read_text())
        bitstream = manifest["artifact_groups"]["bitstream_release"]
        self.assertTrue({"synth", "place_route", "pack"}.issubset(set(bitstream["cli_commands"])))
        artifact_names = {artifact["name"] for artifact in bitstream["artifacts"]}
        self.assertTrue(
            {
                "bitstream",
                "nextpnr_timing_report",
                "nextpnr_route_report",
                "ecppack_transcript",
                "fpga_tool_versions",
            }.issubset(artifact_names)
        )


if __name__ == "__main__":
    unittest.main()
