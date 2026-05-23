#!/usr/bin/env python3
"""Tests for scripts/check_android_system_bridge_contract.py."""

from __future__ import annotations

import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import check_android_system_bridge_contract as gate  # noqa: E402


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


class AndroidSystemBridgeContractTests(unittest.TestCase):
    def _patch_tree(self, tmp: Path):
        system_ui = tmp / "os/android/system-ui"
        native = system_ui / "native"
        vendor = tmp / "os/android/vendor/eliza"
        chip = tmp / "chip"
        bridge_kt = write(
            native / "src/main/java/ai/elizaos/system/bridge/SystemBridge.kt",
            'class SystemBridge { fun subscribeWifi() { throw NotImplementedError("stub") } }\n',
        )
        bridge_manifest = write(
            native / "src/main/AndroidManifest.xml",
            """<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="ai.elizaos.system.bridge">
  <uses-permission android:name="android.permission.REBOOT" />
  <uses-permission android:name="android.permission.DEVICE_POWER" />
  <uses-permission android:name="android.permission.WRITE_SECURE_SETTINGS" />
</manifest>
""",
        )
        bridge_gradle = write(
            native / "build.gradle.kts",
            'plugins { id("com.android.library"); kotlin("android") }\n',
        )
        android_provider = write(
            system_ui / "src/providers/AndroidSystemProvider.tsx",
            "import { MockSystemProvider } from './MockSystemProvider';\n"
            "export function AndroidSystemProvider(){ return <MockSystemProvider />; }\n",
        )
        mock_provider = write(
            system_ui / "src/providers/MockSystemProvider.tsx",
            'const DEFAULT_WIFI = { connected: true, ssid: "eliza-home" };\n',
        )
        bridge_contract = write(
            system_ui / "src/bridge/bridge-contract.ts",
            "\n".join(
                [
                    '"eliza.android.wifi.state"',
                    '"eliza.android.cell.state"',
                    '"eliza.android.audio.state"',
                    '"eliza.android.audio.setLevel"',
                    '"eliza.android.audio.setMuted"',
                    '"eliza.android.battery.state"',
                    '"eliza.android.time.state"',
                    '"eliza.android.connectivity.state"',
                    '"eliza.android.power.shutdown"',
                    '"eliza.android.power.restart"',
                    '"eliza.android.power.sleep"',
                    '"eliza.android.settings.open"',
                    '"eliza.android.lockscreen.state"',
                    '"eliza.android.lockscreen.dismiss"',
                ]
            ),
        )
        os_common = write(
            vendor / "eliza_common.mk",
            "PRODUCT_PACKAGES += Eliza\n",
        )
        local_manifest = write(
            chip / "sw/aosp-device/local_manifests/eliza.xml",
            '<manifest><project><linkfile dest="device/eliza/eliza_ai_soc/device.mk" /></project></manifest>\n',
        )
        patches = [
            mock.patch.object(gate, "WORKSPACE", tmp),
            mock.patch.object(gate, "SYSTEM_UI", system_ui),
            mock.patch.object(gate, "NATIVE", native),
            mock.patch.object(gate, "BRIDGE_KT", bridge_kt),
            mock.patch.object(gate, "BRIDGE_MANIFEST", bridge_manifest),
            mock.patch.object(gate, "BRIDGE_GRADLE", bridge_gradle),
            mock.patch.object(gate, "ANDROID_PROVIDER", android_provider),
            mock.patch.object(gate, "MOCK_PROVIDER", mock_provider),
            mock.patch.object(gate, "BRIDGE_CONTRACT", bridge_contract),
            mock.patch.object(gate, "OS_COMMON", os_common),
            mock.patch.object(gate, "OS_PERMISSION_DIR", vendor / "permissions"),
            mock.patch.object(gate, "LOCAL_MANIFEST", local_manifest),
            mock.patch.object(
                gate,
                "RUNTIME_EVIDENCE",
                chip / "docs/evidence/android/system_bridge_runtime_evidence.json",
            ),
            mock.patch.object(
                gate,
                "RUNTIME_CAPTURE",
                write(
                    chip / "scripts/android/capture_system_bridge_runtime_evidence.py",
                    "#!/usr/bin/env python3\n",
                ),
            ),
        ]
        return patches, vendor

    def test_stubbed_unpacked_mock_bridge_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches, _ = self._patch_tree(Path(tmpdir))
            with PatchStack(patches):
                report = gate.run_check(Namespace())
        self.assertEqual(report["status"], "blocked")
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("system_bridge_native_methods_stubbed", codes)
        self.assertIn("system_bridge_not_packaged_as_app", codes)
        self.assertIn("android_provider_falls_back_to_mock", codes)
        self.assertIn("mock_system_provider_has_realistic_fake_state", codes)
        self.assertIn("system_bridge_not_in_eliza_product_packages", codes)
        self.assertIn("system_bridge_privapp_allowlist_missing", codes)
        self.assertIn("system_bridge_privapp_permissions_not_granted", codes)
        self.assertIn("chip_local_manifest_does_not_project_system_ui", codes)
        self.assertIn("system_bridge_runtime_evidence_missing", codes)

    def test_implemented_packaged_bridge_contract_passes_static_checks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            patches, vendor = self._patch_tree(tmp)
            with PatchStack(patches):
                gate.BRIDGE_KT.write_text(
                    "class SystemBridge { fun subscribeWifi(): Subscription = LiveSubscription() }\n"
                    "interface Subscription { fun cancel() }\n"
                    "class LiveSubscription: Subscription { override fun cancel() {} }\n",
                    encoding="utf-8",
                )
                gate.BRIDGE_GRADLE.write_text(
                    'plugins { id("com.android.application"); kotlin("android") }\n',
                    encoding="utf-8",
                )
                gate.ANDROID_PROVIDER.write_text(
                    "export function AndroidSystemProvider(){ return <BridgeBackedProvider />; }\n",
                    encoding="utf-8",
                )
                gate.MOCK_PROVIDER.write_text(
                    "export function MockSystemProvider(){}\n", encoding="utf-8"
                )
                gate.OS_COMMON.write_text(
                    "PRODUCT_PACKAGES += \\\n"
                    "    ElizaSystemBridge \\\n"
                    "    privapp-permissions-ai.elizaos.system.bridge.xml\n",
                    encoding="utf-8",
                )
                write(
                    vendor / "permissions/privapp-permissions-ai.elizaos.system.bridge.xml",
                    """<permissions>
  <privapp-permissions package="ai.elizaos.system.bridge">
    <permission name="android.permission.REBOOT" />
    <permission name="android.permission.DEVICE_POWER" />
    <permission name="android.permission.WRITE_SECURE_SETTINGS" />
  </privapp-permissions>
</permissions>
""",
                )
                gate.LOCAL_MANIFEST.write_text(
                    '<manifest><project><linkfile dest="vendor/eliza/system-ui/native/build.gradle.kts" /></project></manifest>\n',
                    encoding="utf-8",
                )
                write(
                    gate.RUNTIME_EVIDENCE,
                    """{
  "schema": "eliza.android_system_bridge_runtime_evidence.v1",
  "claim_boundary": "booted_android_system_bridge_runtime_evidence_only",
  "status": "PASS",
  "result": 0,
  "sys_boot_completed": true,
  "package_installed": true,
  "service_registered": true,
  "privapp_permissions_granted": true,
  "js_bridge_bound": true,
  "launcher_consumed_live_state": true,
  "production_mock_fallback_absent": true,
  "logcat_crash_count": 0,
  "selinux_denial_count": 0
}
""",
                )
                report = gate.run_check(Namespace())
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["findings"], [])
        self.assertEqual(report["claim_boundary"], gate.CLAIM_BOUNDARY)

    def test_runtime_evidence_must_be_pass_result_zero_and_schema_bound(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            patches, vendor = self._patch_tree(tmp)
            with PatchStack(patches):
                gate.BRIDGE_KT.write_text(
                    "class SystemBridge { fun subscribeWifi(): Subscription = LiveSubscription() }\n"
                    "interface Subscription { fun cancel() }\n"
                    "class LiveSubscription: Subscription { override fun cancel() {} }\n",
                    encoding="utf-8",
                )
                gate.BRIDGE_GRADLE.write_text(
                    'plugins { id("com.android.application"); kotlin("android") }\n',
                    encoding="utf-8",
                )
                gate.ANDROID_PROVIDER.write_text(
                    "export function AndroidSystemProvider(){ return <BridgeBackedProvider />; }\n",
                    encoding="utf-8",
                )
                gate.MOCK_PROVIDER.write_text(
                    "export function MockSystemProvider(){}\n", encoding="utf-8"
                )
                gate.OS_COMMON.write_text(
                    "PRODUCT_PACKAGES += \\\n"
                    "    ElizaSystemBridge \\\n"
                    "    privapp-permissions-ai.elizaos.system.bridge.xml\n",
                    encoding="utf-8",
                )
                write(
                    vendor / "permissions/privapp-permissions-ai.elizaos.system.bridge.xml",
                    """<permissions>
  <privapp-permissions package="ai.elizaos.system.bridge">
    <permission name="android.permission.REBOOT" />
    <permission name="android.permission.DEVICE_POWER" />
    <permission name="android.permission.WRITE_SECURE_SETTINGS" />
  </privapp-permissions>
</permissions>
""",
                )
                gate.LOCAL_MANIFEST.write_text(
                    '<manifest><project><linkfile dest="vendor/eliza/system-ui/native/build.gradle.kts" /></project></manifest>\n',
                    encoding="utf-8",
                )
                write(
                    gate.RUNTIME_EVIDENCE,
                    """{
  "schema": "wrong.schema",
  "claim_boundary": "static_claim",
  "status": "BLOCKED",
  "result": 2,
  "sys_boot_completed": true,
  "package_installed": true,
  "service_registered": true,
  "privapp_permissions_granted": true,
  "js_bridge_bound": true,
  "launcher_consumed_live_state": true,
  "production_mock_fallback_absent": true,
  "logcat_crash_count": 0,
  "selinux_denial_count": 0
}
""",
                )
                report = gate.run_check(Namespace())
        self.assertEqual(report["status"], "blocked")
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("system_bridge_runtime_schema_mismatch", codes)
        self.assertIn("system_bridge_runtime_claim_boundary_mismatch", codes)
        self.assertIn("system_bridge_runtime_status_not_pass", codes)
        self.assertIn("system_bridge_runtime_result_not_zero", codes)


class PatchStack:
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
