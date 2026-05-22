#!/usr/bin/env python3
"""Tests for scripts/check_chip_os_environment_preflight.py."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import check_chip_os_environment_preflight as preflight


class ChipOsEnvironmentPreflightTests(unittest.TestCase):
    def test_missing_tool_env_and_path_are_reported(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            with mock.patch.object(preflight, "REPO", repo):
                report = preflight.build_report(env={}, which=lambda _name: None)

        self.assertEqual(report["status"], "blocked")
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("missing_tool_qemu_system_riscv64", codes)
        self.assertIn("missing_env_aosp_dir", codes)
        self.assertIn("missing_path_chipyard_checkout", codes)
        self.assertIn("missing_tool_aapt", codes)

    def test_present_tool_env_and_path_can_pass(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            for spec in preflight.PATHS:
                path = repo / spec.path
                if spec.glob:
                    path = path.parent / "elizaos-linux-riscv64-test.iso"
                path.parent.mkdir(parents=True, exist_ok=True)
                if spec.writable:
                    path.mkdir(exist_ok=True)
                else:
                    path.write_text("ok\n", encoding="utf-8")
            env = {spec.name: "value" for spec in preflight.ENVS}
            with mock.patch.object(preflight, "REPO", repo):
                report = preflight.build_report(env=env, which=lambda name: f"/bin/{name}")

        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["summary"]["findings"], 0)

    def test_preflight_covers_android_agent_payload_and_release_tools(self) -> None:
        tools = {spec.name for spec in preflight.TOOLS}
        paths = {spec.ident for spec in preflight.PATHS}
        self.assertTrue(
            {
                "aapt",
                "apkanalyzer",
                "curl",
                "jq",
                "node",
                "bun",
            }.issubset(tools)
        )
        self.assertTrue(
            {
                "android_app_agent_plugin_manifest",
                "android_release_manifest",
                "android_post_flash_validator",
                "android_release_manifest_validator",
            }.issubset(paths)
        )


if __name__ == "__main__":
    unittest.main()
