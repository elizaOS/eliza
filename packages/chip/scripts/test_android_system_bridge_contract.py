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


def assert_false_claim_flags(testcase: unittest.TestCase, report: dict[str, object]) -> None:
    testcase.assertEqual(report["claim_boundary"], gate.CLAIM_BOUNDARY)
    for key, expected in gate.FALSE_CLAIM_FLAGS.items():
        testcase.assertIs(report.get(key), expected, key)


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


class AndroidSystemBridgeContractTests(unittest.TestCase):
    def _patch_tree(self, tmp: Path):
        system_ui = tmp / "os/android/system-ui"
        native = system_ui / "native"
        vendor = tmp / "os/android/vendor/milady"
        chip = tmp / "chip"
        bridge_kt = write(
            native / "src/main/java/ai/elizaos/system/bridge/SystemBridge.kt",
            'class SystemBridge { fun subscribeWifi() { throw NotImplementedError("stub") } }\n',
        )
        bridge_service = native / "src/main/java/ai/elizaos/system/bridge/SystemBridgeService.kt"
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
            vendor / f"{gate.VENDOR_DIR_NAME}_common.mk",
            "PRODUCT_PACKAGES += Eliza\n",
        )
        launcher_main = write(
            tmp / "app-core/platforms/android/app/src/main/java/ai/milady/milady/MainActivity.java",
            'class MainActivity { void onCreate(){ webView.addJavascriptInterface(new ElizaNativeBridge(), "ElizaNative"); } }\n',
        )
        local_manifest = write(
            chip / "sw/aosp-device/local_manifests/eliza.xml",
            '<manifest><project><linkfile dest="device/eliza/eliza_ai_soc/device.mk" /></project></manifest>\n',
        )
        patches = [
            mock.patch.object(gate, "WORKSPACE", tmp),
            mock.patch.object(gate, "APP_PACKAGE", "ai.milady.milady"),
            mock.patch.object(gate, "APP_NAME", "Milady"),
            mock.patch.object(gate, "VENDOR_DIR_NAME", "milady"),
            mock.patch.object(
                gate,
                "REQUIRED_MATERIALIZED_LOCAL_MANIFEST_DESTS",
                {
                    "vendor/milady/apps/Milady/Milady.apk",
                    "vendor/milady/bootanimation/bootanimation.zip",
                    "vendor/milady/init/init.milady.rc",
                    "vendor/milady/permissions/default-permissions-ai.milady.milady.xml",
                    "vendor/milady/permissions/privapp-permissions-ai.milady.milady.xml",
                    "vendor/milady/permissions/privapp-permissions-ai.elizaos.system.bridge.xml",
                },
            ),
            mock.patch.object(
                gate,
                "EXPECTED_RUNTIME_PERMISSION_XMLS",
                {
                    "/system/etc/default-permissions/default-permissions-ai.milady.milady.xml",
                    "/system/etc/permissions/privapp-permissions-ai.milady.milady.xml",
                    "/system/etc/permissions/privapp-permissions-ai.elizaos.system.bridge.xml",
                },
            ),
            mock.patch.object(gate, "SYSTEM_UI", system_ui),
            mock.patch.object(gate, "NATIVE", native),
            mock.patch.object(gate, "BRIDGE_KT", bridge_kt),
            mock.patch.object(gate, "BRIDGE_SERVICE_KT", bridge_service),
            mock.patch.object(gate, "BRIDGE_MANIFEST", bridge_manifest),
            mock.patch.object(gate, "BRIDGE_GRADLE", bridge_gradle),
            mock.patch.object(gate, "ANDROID_PROVIDER", android_provider),
            mock.patch.object(gate, "MOCK_PROVIDER", mock_provider),
            mock.patch.object(gate, "BRIDGE_CONTRACT", bridge_contract),
            mock.patch.object(gate, "LAUNCHER_MAIN_ACTIVITY", launcher_main),
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
        assert_false_claim_flags(self, report)
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("system_bridge_native_methods_stubbed", codes)
        self.assertIn("system_bridge_service_class_missing_or_unbound", codes)
        self.assertIn("launcher_webview_does_not_bind_system_bridge", codes)
        self.assertIn("system_bridge_not_packaged_as_app", codes)
        self.assertIn("android_provider_falls_back_to_mock", codes)
        self.assertIn("mock_system_provider_has_realistic_fake_state", codes)
        self.assertIn("system_bridge_not_in_eliza_product_packages", codes)
        self.assertIn("system_bridge_privapp_allowlist_missing", codes)
        self.assertIn("system_bridge_privapp_permissions_not_granted", codes)
        self.assertIn("chip_local_manifest_does_not_project_system_ui", codes)
        self.assertIn("chip_local_manifest_missing_system_bridge_service", codes)
        self.assertIn("system_bridge_runtime_evidence_missing", codes)
        self.assertEqual(
            report["summary"]["blocker_dependency_counts"],
            report["blocker_dependency_counts"],
        )
        self.assertGreaterEqual(report["blocker_dependency_counts"]["live_device_validation"], 1)
        command_ids = {item["id"] for item in report["next_command_plan"]}
        self.assertIn("capture_android_system_bridge_runtime_evidence", command_ids)
        self.assertIn("rebuild_android_product_after_bridge_packaging_fix", command_ids)
        self.assertEqual(
            report["summary"]["next_command_batch_count"],
            len(report["next_command_plan"]),
        )
        runtime_batch = next(
            item
            for item in report["next_command_plan"]
            if item["id"] == "capture_android_system_bridge_runtime_evidence"
        )
        self.assertIn(
            "capture_system_bridge_runtime_evidence.py",
            " ".join(runtime_batch["commands"]),
        )

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
                gate.BRIDGE_SERVICE_KT.write_text(
                    "class SystemBridgeService: android.app.Service() {\n"
                    "  override fun onBind(intent: android.content.Intent?) = null\n"
                    '  fun marker() = "ElizaSystemBridge: bound"\n'
                    "}\n",
                    encoding="utf-8",
                )
                gate.LAUNCHER_MAIN_ACTIVITY.write_text(
                    'class MainActivity { void onCreate(){ webView.addJavascriptInterface(systemBridge, "__elizaAndroidBridge"); } }\n',
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
                    "<manifest><project>"
                    f'<linkfile dest="vendor/{gate.VENDOR_DIR_NAME}/system-ui/native/build.gradle.kts" />'
                    f'<linkfile dest="vendor/{gate.VENDOR_DIR_NAME}/system-ui/native/src/main/java/ai/elizaos/system/bridge/SystemBridgeService.kt" />'
                    + "".join(
                        f'<copyfile dest="{dest}" />'
                        for dest in sorted(gate.REQUIRED_MATERIALIZED_LOCAL_MANIFEST_DESTS)
                    )
                    + "</project></manifest>\n",
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
  "system_privapp_apk_present": true,
  "package_installed": true,
  "service_registered": true,
  "privapp_permissions_granted": true,
  "js_bridge_bound": true,
  "launcher_consumed_live_state": true,
  "production_mock_fallback_absent": true,
  "permission_xml_host_symlink_absent": true,
  "launcher_package": "ai.milady.milady",
  "observations": {
    "permission_file_probes": {
      "/system/etc/default-permissions/default-permissions-ai.milady.milady.xml": "-rw-r--r-- default-permissions-ai.milady.milady.xml",
      "/system/etc/permissions/privapp-permissions-ai.milady.milady.xml": "-rw-r--r-- privapp-permissions-ai.milady.milady.xml",
      "/system/etc/permissions/privapp-permissions-ai.elizaos.system.bridge.xml": "-rw-r--r-- privapp-permissions-ai.elizaos.system.bridge.xml"
    },
    "permission_file_symlink_targets": {
      "/system/etc/default-permissions/default-permissions-ai.milady.milady.xml": {"readlink": "", "readlink_f": "", "readlink_ok": "false", "readlink_f_ok": "false"},
      "/system/etc/permissions/privapp-permissions-ai.milady.milady.xml": {"readlink": "", "readlink_f": "", "readlink_ok": "false", "readlink_f_ok": "false"},
      "/system/etc/permissions/privapp-permissions-ai.elizaos.system.bridge.xml": {"readlink": "", "readlink_f": "", "readlink_ok": "false", "readlink_f_ok": "false"}
    }
  },
  "logcat_crash_count": 0,
  "selinux_denial_count": 0
}
""",
                )
                report = gate.run_check(Namespace())
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["findings"], [])
        self.assertEqual(report["next_command_plan"], [])
        self.assertEqual(report["blocker_dependency_counts"], {})
        self.assertEqual(report["summary"]["next_command_batch_count"], 0)
        assert_false_claim_flags(self, report)

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
                gate.BRIDGE_SERVICE_KT.write_text(
                    "class SystemBridgeService: android.app.Service() {\n"
                    "  override fun onBind(intent: android.content.Intent?) = null\n"
                    '  fun marker() = "ElizaSystemBridge: bound"\n'
                    "}\n",
                    encoding="utf-8",
                )
                gate.LAUNCHER_MAIN_ACTIVITY.write_text(
                    'class MainActivity { void onCreate(){ webView.addJavascriptInterface(systemBridge, "__elizaAndroidBridge"); } }\n',
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
                    "<manifest><project>"
                    '<linkfile dest="vendor/milady/system-ui/native/build.gradle.kts" />'
                    '<linkfile dest="vendor/milady/system-ui/native/src/main/java/ai/elizaos/system/bridge/SystemBridgeService.kt" />'
                    '<copyfile dest="vendor/milady/apps/Milady/Milady.apk" />'
                    '<copyfile dest="vendor/milady/bootanimation/bootanimation.zip" />'
                    '<copyfile dest="vendor/milady/init/init.milady.rc" />'
                    '<copyfile dest="vendor/milady/permissions/default-permissions-ai.milady.milady.xml" />'
                    '<copyfile dest="vendor/milady/permissions/privapp-permissions-ai.milady.milady.xml" />'
                    '<copyfile dest="vendor/milady/permissions/privapp-permissions-ai.elizaos.system.bridge.xml" />'
                    "</project></manifest>\n",
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
        assert_false_claim_flags(self, report)
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("system_bridge_runtime_schema_mismatch", codes)
        self.assertIn("system_bridge_runtime_claim_boundary_mismatch", codes)
        self.assertIn("system_bridge_runtime_status_not_pass", codes)
        self.assertIn("system_bridge_runtime_result_not_zero", codes)

    def test_local_manifest_permission_xmls_must_be_copyfiles(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            manifest = write(
                Path(tmpdir) / "eliza.xml",
                """<manifest><project>
  <linkfile dest="vendor/eliza/permissions/default-permissions-ai.elizaos.app.xml" />
  <copyfile dest="vendor/eliza/permissions/privapp-permissions-ai.elizaos.app.xml" />
</project></manifest>
""",
            )
            projections = gate.local_manifest_file_projection_kinds(manifest)
        self.assertEqual(
            projections["vendor/eliza/permissions/default-permissions-ai.elizaos.app.xml"],
            "linkfile",
        )
        self.assertEqual(
            projections["vendor/eliza/permissions/privapp-permissions-ai.elizaos.app.xml"],
            "copyfile",
        )

    def test_permission_xml_symlink_detection_blocks_non_android_targets(self) -> None:
        self.assertTrue(
            gate.contains_host_local_symlink(
                {
                    "/system/etc/permissions/foo.xml": (
                        "lrwxrwxrwx root root foo.xml -> "
                        "/private/tmp/aosp/packages/os/android/vendor/eliza/permissions/foo.xml"
                    )
                }
            )
        )
        self.assertFalse(
            gate.contains_host_local_symlink(
                {"/system/etc/permissions/foo.xml": "foo.xml -> /vendor/etc/permissions/foo.xml"}
            )
        )

    def test_runtime_permission_paths_block_stale_launcher_identity(self) -> None:
        stale = gate.stale_runtime_permission_paths(
            [
                "/system/etc/default-permissions/default-permissions-app.eliza.xml",
                "/system/etc/permissions/privapp-permissions-app.eliza.xml",
                "/system/etc/permissions/privapp-permissions-ai.elizaos.system.bridge.xml",
            ]
        )
        self.assertEqual(
            stale,
            [
                "/system/etc/default-permissions/default-permissions-app.eliza.xml",
                "/system/etc/permissions/privapp-permissions-app.eliza.xml",
            ],
        )

    def test_android_gradle_identity_uses_application_id(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            gradle = write(
                Path(tmpdir) / "build.gradle",
                'android { namespace "ai.old.namespace"; defaultConfig { applicationId "ai.milady.milady" } }\n',
            )
            with mock.patch.object(gate, "ANDROID_APP_GRADLE", gradle):
                self.assertEqual(
                    gate.read_android_gradle_identity(),
                    {"appId": "ai.milady.milady"},
                )


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
