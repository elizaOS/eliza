#!/usr/bin/env python3
"""Tests for scripts/check_chip_os_environment_preflight.py."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import check_chip_os_environment_preflight as preflight


def assert_false_claim_flags(testcase: unittest.TestCase, report: dict[str, object]) -> None:
    testcase.assertEqual(report["claim_boundary"], preflight.CLAIM_BOUNDARY)
    for key, expected in preflight.FALSE_CLAIM_FLAGS.items():
        testcase.assertIs(report.get(key), expected, key)


class ChipOsEnvironmentPreflightTests(unittest.TestCase):
    def test_missing_tool_env_and_path_are_reported(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            with (
                mock.patch.object(preflight, "REPO", repo),
                mock.patch.object(preflight, "ENV_DEFAULT_PATHS", {}),
                mock.patch.object(preflight, "ENV_DEFAULT_COMMANDS", {}),
                mock.patch.object(preflight, "TOOL_DEFAULT_PATHS", {}),
            ):
                report = preflight.build_report(env={}, which=lambda _name: None)

        self.assertEqual(report["status"], "blocked")
        assert_false_claim_flags(self, report)
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
        assert_false_claim_flags(self, report)
        self.assertEqual(report["summary"]["findings"], 0)

    def test_missing_aosp_smoke_envs_include_capture_hints(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            aosp = repo / "aosp"
            aosp.mkdir()
            with (
                mock.patch.object(preflight, "REPO", repo),
                mock.patch.object(
                    preflight,
                    "ENV_DEFAULT_PATHS",
                    {"AOSP_DIR": (aosp,)},
                ),
                mock.patch.object(preflight, "ENV_DEFAULT_COMMANDS", {}),
                mock.patch.object(preflight, "TOOL_DEFAULT_PATHS", {}),
            ):
                report = preflight.build_report(env={}, which=lambda _name: "/bin/tool")

        env_rows = {row["name"]: row for row in report["environment"]}
        qemu_hint = env_rows["AOSP_QEMU_SMOKE_COMMAND"]["command_hint"]
        renode_hint = env_rows["AOSP_RENODE_SMOKE_COMMAND"]["command_hint"]
        self.assertEqual(qemu_hint["capture_mode"], "qemu-smoke")
        self.assertIn("capture-aosp-evidence.sh", qemu_hint["capture_command"])
        self.assertIn(str(aosp), qemu_hint["capture_command"])
        self.assertIn("AOSP_QEMU_SMOKE_COMMAND=", qemu_hint["suggested_export"])
        self.assertEqual(renode_hint["capture_mode"], "renode-smoke")

        findings = {finding["code"]: finding for finding in report["findings"]}
        self.assertIn("capture_command", findings["missing_env_aosp_qemu_smoke_command"])
        self.assertIn("suggested_export", findings["missing_env_aosp_renode_smoke_command"])

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

    def test_output_report_sanitizes_host_local_paths_and_adds_timestamp(self) -> None:
        report = {
            "schema": preflight.SCHEMA,
            "status": "pass",
            "environment": [
                {
                    "name": "AOSP_DIR",
                    "value": "/home/shaw/aosp",
                    "command_hint": {
                        "capture_command": "/home/shaw/milady/eliza/packages/chip/script.sh /home/shaw/aosp"
                    },
                }
            ],
            "tools": [{"path": "/home/shaw/Android/Sdk/platform-tools/adb"}],
        }

        output = preflight.report_for_output(report)
        text = json.dumps(output)
        self.assertRegex(output["generated_utc"], r"^\d{4}-\d{2}-\d{2}T")
        self.assertNotIn("/home/shaw", text)
        self.assertIn("$AOSP_DIR", text)


if __name__ == "__main__":
    unittest.main()
