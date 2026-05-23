#!/usr/bin/env python3
"""Tests for scripts/check_android_app_runtime_contract.py."""

from __future__ import annotations

import sys
import tempfile
import unittest
import zipfile
from argparse import Namespace
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import check_android_app_runtime_contract as gate  # noqa: E402


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def make_apk(path: Path, entries: list[str]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as archive:
        for entry in entries:
            archive.writestr(entry, b"fixture")
    return path


class AndroidAppRuntimeContractTests(unittest.TestCase):
    def _patch_paths(self, tmp: Path, apk_entries: list[str]):
        app_gradle = write(
            tmp / "app-core/platforms/android/app/build.gradle",
            'android { defaultConfig { applicationId "ai.elizaos.app" } }\n',
        )
        app_manifest = write(
            tmp / "app-core/platforms/android/app/src/main/AndroidManifest.xml",
            """<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application>
    <service android:name=".ElizaAgentService" android:exported="false" />
  </application>
</manifest>
""",
        )
        service_java = write(
            tmp
            / "app-core/platforms/android/app/src/main/java/ai/elizaos/app/ElizaAgentService.java",
            'class ElizaAgentService { static final String HEALTH_URL = "http://127.0.0.1:31337/api/health"; }\n',
        )
        write(
            tmp / "app-core/platforms/android/app/src/main/java/ai/elizaos/app/AgentPlugin.java",
            'class AgentPlugin { String path = "/api/health"; }\n',
        )
        native_bridge_java = write(
            tmp
            / "app-core/platforms/android/app/src/main/java/ai/elizaos/app/ElizaNativeBridge.java",
            "class ElizaNativeBridge { String getLocalAgentToken() { return null; } }\n",
        )
        apk = make_apk(tmp / "os/android/vendor/eliza/apps/Eliza/Eliza.apk", apk_entries)
        default_permissions = write(
            tmp / "os/android/vendor/eliza/permissions/default-permissions-ai.elizaos.app.xml",
            '<exceptions><exception package="ai.elizaos.app" /></exceptions>\n',
        )
        priv_permissions = write(
            tmp / "os/android/vendor/eliza/permissions/privapp-permissions-ai.elizaos.app.xml",
            '<permissions><privapp-permissions package="ai.elizaos.app" /></permissions>\n',
        )
        overlay = write(
            tmp / "os/android/vendor/eliza/overlays/frameworks/base/core/res/res/values/config.xml",
            '<resources><string name="config_defaultAssistant">ai.elizaos.app</string></resources>\n',
        )
        common_mk = write(
            tmp / "os/android/vendor/eliza/eliza_common.mk",
            "PRODUCT_SYSTEM_PROPERTIES += ro.elizaos.home=ai.elizaos.app\n",
        )
        start_script = write(
            tmp / "chip/sw/aosp-device/start-eliza-agent-riscv64.sh",
            "package=${AOSP_AGENT_PACKAGE:-com.elizaos.agent}\n"
            "service=${AOSP_AGENT_SERVICE:-com.elizaos.agent/.AgentForegroundService}\n"
            'adb shell am start-foreground-service -n "$service"\n'
            "url=/api/agent/self-status\n",
        )
        smoke_script = write(
            tmp / "chip/sw/aosp-device/scripts/cuttlefish_agent_smoke.py",
            'package = env("AOSP_AGENT_PACKAGE", "com.elizaos.agent")\n'
            'service = env("AOSP_AGENT_SERVICE", "com.elizaos.agent/.AgentService")\n'
            'self_status_url = f"{base_url}/api/agent/self-status"\n',
        )
        agent_smoke = write(
            tmp / "chip/sw/aosp-device/agent-smoke-riscv64.sh",
            "package=${AOSP_AGENT_PACKAGE:-com.elizaos.agent}\n"
            "service=${AOSP_AGENT_SERVICE:-com.elizaos.agent/.AgentForegroundService}\n",
        )
        capture = write(
            tmp / "chip/sw/aosp-device/capture-aosp-evidence.sh",
            "aosp_agent_package=${AOSP_AGENT_PACKAGE:-com.elizaos.agent}\n"
            "aosp_agent_service=${AOSP_AGENT_SERVICE:-com.elizaos.agent/.AgentService}\n",
        )
        install = write(
            tmp / "chip/sw/aosp-device/install-eliza-apk-riscv64.sh",
            "package=${AOSP_AGENT_PACKAGE:-com.elizaos.agent}\n",
        )
        patches = [
            mock.patch.object(gate, "WORKSPACE", tmp),
            mock.patch.object(gate, "ROOT", tmp / "chip"),
            mock.patch.object(gate, "APP_GRADLE", app_gradle),
            mock.patch.object(gate, "APP_MANIFEST", app_manifest),
            mock.patch.object(gate, "APP_JAVA_DIR", service_java.parent),
            mock.patch.object(gate, "AGENT_SERVICE_JAVA", service_java),
            mock.patch.object(gate, "NATIVE_BRIDGE_JAVA", native_bridge_java),
            mock.patch.object(gate, "PREBUILT_APK", apk),
            mock.patch.object(
                gate, "VENDOR_PERMISSION_XMLS", (default_permissions, priv_permissions)
            ),
            mock.patch.object(gate, "VENDOR_OVERLAY", overlay),
            mock.patch.object(gate, "VENDOR_COMMON_MK", common_mk),
            mock.patch.object(
                gate,
                "CHIP_AOSP_SCRIPTS",
                (start_script, agent_smoke, smoke_script, capture, install),
            ),
        ]
        return patches

    def test_current_style_mismatches_are_blocked(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            patches = self._patch_paths(
                tmp,
                [
                    "lib/arm64-v8a/libfoo.so",
                    "lib/x86_64/libfoo.so",
                    "assets/agent/arm64-v8a/launch.sh",
                    "assets/agent/x86_64/launch.sh",
                ],
            )
            with contextlib_stack(patches):
                payload = gate.run_check(
                    Namespace(
                        apk=None,
                        apk_package_id="app.eliza",
                        apkanalyzer=None,
                    )
                )
        self.assertEqual(payload["status"], "blocked")
        codes = {finding["code"] for finding in payload["findings"]}
        self.assertIn("android_package_identity_mismatch", codes)
        self.assertIn("apk_missing_riscv64_native_libs", codes)
        self.assertIn("apk_missing_riscv64_agent_assets", codes)
        self.assertIn("android_service_identity_mismatch", codes)
        self.assertIn("android_agent_service_not_exported_for_adb_smoke", codes)
        self.assertIn("android_agent_health_contract_mismatch", codes)

    def test_aligned_static_contract_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            patches = self._patch_paths(
                tmp,
                [
                    "lib/riscv64/libfoo.so",
                    "assets/agent/riscv64/launch.sh",
                ],
            )
            with contextlib_stack(patches):
                gate.APP_GRADLE.write_text(
                    'android { defaultConfig { applicationId "ai.elizaos.app" } }\n',
                    encoding="utf-8",
                )
                for path in gate.VENDOR_PERMISSION_XMLS:
                    path.write_text(
                        path.read_text(encoding="utf-8"),
                        encoding="utf-8",
                    )
                gate.VENDOR_OVERLAY.write_text(
                    '<resources><string name="config_defaultAssistant">ai.elizaos.app</string></resources>\n',
                    encoding="utf-8",
                )
                gate.VENDOR_COMMON_MK.write_text(
                    "PRODUCT_SYSTEM_PROPERTIES += ro.elizaos.home=ai.elizaos.app\n",
                    encoding="utf-8",
                )
                for path in gate.CHIP_AOSP_SCRIPTS:
                    path.write_text(
                        "package=${AOSP_AGENT_PACKAGE:-ai.elizaos.app}\n"
                        "service=${AOSP_AGENT_SERVICE:-ai.elizaos.app/.ElizaAgentService}\n"
                        "url=/api/health\n",
                        encoding="utf-8",
                    )
                payload = gate.run_check(
                    Namespace(
                        apk=None,
                        apk_package_id="ai.elizaos.app",
                        apkanalyzer=None,
                    )
                )
        self.assertEqual(payload["status"], "pass")
        self.assertEqual(payload["findings"], [])
        self.assertEqual(payload["claim_boundary"], gate.CLAIM_BOUNDARY)


class contextlib_stack:
    def __init__(self, patches):
        self._patches = patches
        self._entered = []

    def __enter__(self):
        for patch in self._patches:
            self._entered.append(patch)
            patch.__enter__()
        return self

    def __exit__(self, exc_type, exc, tb):
        while self._entered:
            self._entered.pop().__exit__(exc_type, exc, tb)


if __name__ == "__main__":
    unittest.main()
