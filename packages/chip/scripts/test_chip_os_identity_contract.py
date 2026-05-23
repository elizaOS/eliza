#!/usr/bin/env python3
"""Tests for scripts/check_chip_os_identity_contract.py."""

from __future__ import annotations

import json
import unittest

import check_chip_os_identity_contract as ident


class ChipOsIdentityContractTests(unittest.TestCase):
    def test_endpoint_literals_extracts_health_and_self_status(self) -> None:
        text = 'curl http://127.0.0.1:31337/api/health && curl "/api/agent/self-status"'
        self.assertEqual(
            ident.endpoint_literals(text),
            {"/api/health", "/api/agent/self-status"},
        )

    def test_script_default_parses_shell_and_python_defaults(self) -> None:
        self.assertEqual(
            ident.script_default("pkg=${AOSP_AGENT_PACKAGE:-ai.elizaos.app}", "AOSP_AGENT_PACKAGE"),
            "ai.elizaos.app",
        )
        self.assertEqual(
            ident.script_default(
                'env("AOSP_AGENT_SERVICE", "ai.elizaos.app/.ElizaAgentService")',
                "AOSP_AGENT_SERVICE",
            ),
            "ai.elizaos.app/.ElizaAgentService",
        )
        self.assertEqual(
            ident.script_default('agent_package="ai.elizaos.app"', "AOSP_AGENT_PACKAGE"),
            "ai.elizaos.app",
        )
        self.assertEqual(
            ident.script_default(
                'agent_service="ai.elizaos.app/.ElizaAgentService"', "AOSP_AGENT_SERVICE"
            ),
            "ai.elizaos.app/.ElizaAgentService",
        )

    def test_report_payload_extracts_observed_identity_tokens(self) -> None:
        report = ident.report_payload(
            [],
            {
                "declared_packages": {
                    "gradle_application_id": "app.eliza",
                    "vendor_ro_home": "ai.elizaos.app",
                },
                "docs": ["com.elizaos.agent"],
            },
        )
        self.assertEqual(report["status"], "pass")
        self.assertEqual(
            report["summary"]["packages_observed"],
            ["ai.elizaos.app", "app.eliza", "com.elizaos.agent"],
        )

    def test_identity_inputs_include_release_and_plugin_manifest_surfaces(self) -> None:
        self.assertTrue(
            ident.APP_AGENT_PLUGIN_MANIFEST.as_posix().endswith("plugins-manifest.json")
        )
        self.assertGreaterEqual(len(ident.ANDROID_RELEASE_MANIFESTS), 2)

    def test_release_validation_tokens_extracts_launcher_agent_contract(self) -> None:
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "manifest.json"
            path.write_text(
                json.dumps(
                    {
                        "validation": {
                            "checks": [
                                "pm path",
                                "cmd role holders",
                                "foreground",
                                "service",
                                "/api/health",
                                "logcat",
                                "selinux",
                            ]
                        }
                    }
                ),
                encoding="utf-8",
            )
            self.assertEqual(
                ident.release_validation_tokens(path),
                {
                    "pm path",
                    "cmd role holders",
                    "foreground",
                    "service",
                    "/api/health",
                    "logcat",
                    "selinux",
                },
            )


if __name__ == "__main__":
    unittest.main()
