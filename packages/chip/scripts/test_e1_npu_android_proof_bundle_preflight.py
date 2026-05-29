#!/usr/bin/env python3
"""Tests for scripts/check_e1_npu_android_proof_bundle_preflight.py."""

from __future__ import annotations

import os
import json
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest import mock

import check_e1_npu_android_proof_bundle_preflight as preflight


class AndroidProofBundlePreflightTests(unittest.TestCase):
    def test_blocks_missing_aosp_adb_and_counter_envs(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            env = {
                "E1_NPU_WRITE_PROOF_JSON": "1",
                "E1_NPU_TFLITE_MODEL": str(Path(td) / "missing.tflite"),
            }
            args = Namespace(aosp_tree=str(Path(td) / "missing-aosp"), no_adb_probe=False)
            with mock.patch.object(preflight.shutil, "which", return_value=None):
                rc, report = preflight.build_report(args, env)

        self.assertEqual(rc, 2)
        codes = {item["code"] for item in report["blockers"]}
        self.assertIn("aosp_tree_not_directory", codes)
        self.assertIn("adb_not_found", codes)
        self.assertIn("mobile_smoke_model_missing", codes)
        self.assertIn("missing_env_e1_npu_macs_per_inference", codes)

    def test_passes_with_ready_shape_without_adb_probe(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            aosp = root / "aosp"
            for rel in (
                "build/envsetup.sh",
                "out/host/linux-x86/cts/android-cts/tools/cts-tradefed",
                "out/host/linux-x86/vts/android-vts/tools/vts-tradefed",
                "out/host/linux-x86/bin/checkvintf",
            ):
                path = aosp / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("#!/bin/sh\n", encoding="utf-8")
                path.chmod(0o755)
            model = root / "model.tflite"
            model.write_bytes(b"model")
            env = {
                "E1_NPU_TFLITE_MODEL": str(model),
                "E1_NPU_WRITE_PROOF_JSON": "0",
            }
            args = Namespace(aosp_tree=str(aosp), no_adb_probe=True)
            with mock.patch.object(preflight.shutil, "which", return_value="/bin/adb"):
                rc, report = preflight.build_report(args, env)

        self.assertEqual(rc, 0)
        codes = {item["code"] for item in report["blockers"]}
        self.assertEqual(codes, set())
        self.assertEqual(report["adb"]["status"], "not_probed")
        self.assertEqual(
            {item["name"]: item["status"] for item in report["tradefed_artifacts"]},
            {"cts-tradefed": "ready", "vts-tradefed": "ready"},
        )
        self.assertEqual(
            report["tradefed_build_command"],
            "scripts/android/build_cts_vts_tradefed.sh",
        )

    def test_tradefed_blockers_point_to_build_helper(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            aosp = root / "aosp"
            for rel in (
                "build/envsetup.sh",
                "out/host/linux-x86/bin/checkvintf",
            ):
                path = aosp / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("#!/bin/sh\n", encoding="utf-8")
                path.chmod(0o755)
            model = root / "model.tflite"
            model.write_bytes(b"model")
            args = Namespace(aosp_tree=str(aosp), no_adb_probe=True)
            env = {"E1_NPU_TFLITE_MODEL": str(model), "E1_NPU_WRITE_PROOF_JSON": "0"}
            with mock.patch.object(preflight.shutil, "which", return_value="/bin/adb"):
                rc, report = preflight.build_report(args, env)

        self.assertEqual(rc, 2)
        blockers = {item["code"]: item for item in report["blockers"]}
        self.assertIn("cts_tradefed_missing", blockers)
        self.assertIn("vts_tradefed_missing", blockers)
        self.assertIn("scripts/android/build_cts_vts_tradefed.sh", blockers["cts_tradefed_missing"]["next_step"])

    def test_report_sanitizes_host_local_paths(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            aosp = root / "aosp"
            (aosp / "build").mkdir(parents=True)
            (aosp / "build/envsetup.sh").write_text("# env\n", encoding="utf-8")
            model = root / "mobile_smoke.tflite"
            model.write_bytes(b"model")
            args = Namespace(aosp_tree=str(aosp), no_adb_probe=True)
            env = {"E1_NPU_TFLITE_MODEL": str(model), "E1_NPU_WRITE_PROOF_JSON": "0"}
            with mock.patch.object(preflight.shutil, "which", return_value="/home/shaw/Android/Sdk/platform-tools/adb"):
                _rc, report = preflight.build_report(args, env)

        encoded = json.dumps(report, sort_keys=True)
        self.assertIn("generated_utc", report)
        self.assertEqual(report["claim_boundary"], preflight.CLAIM_BOUNDARY)
        self.assertNotIn("/home/shaw", encoded)
        self.assertNotIn(str(root), encoded)
        self.assertIn("$AOSP_TREE", encoded)


if __name__ == "__main__":
    unittest.main()
