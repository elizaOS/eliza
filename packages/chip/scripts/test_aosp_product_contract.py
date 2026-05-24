#!/usr/bin/env python3
"""Tests for scripts/check_aosp_product_contract.py."""

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

import check_aosp_product_contract as gate  # noqa: E402


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


class AospProductContractTests(unittest.TestCase):
    def _patch_tree(self, tmp: Path):
        chip = tmp / "chip/sw/aosp-device"
        device = chip / "device/eliza/eliza_ai_soc"
        vendor = tmp / "os/android/vendor/eliza"
        build_script = write(
            chip / "build-aosp-riscv64.sh",
            'LUNCH_TARGET="aosp_cf_riscv64_phone-trunk_staging-userdebug"\n',
        )
        boot_script = write(
            tmp / "chip/scripts/boot_android_simulator.sh",
            "aosp_product=${AOSP_PRODUCT:-eliza_ai_soc-trunk_staging-userdebug}\n"
            "aosp_cuttlefish_product=${AOSP_CUTTLEFISH_PRODUCT:-aosp_cf_riscv64_phone-trunk_staging-userdebug}\n",
        )
        capture_script = write(
            chip / "capture-aosp-evidence.sh",
            "aosp_product=${AOSP_PRODUCT:-eliza_ai_soc-trunk_staging-userdebug}\n"
            "aosp_cuttlefish_product=${AOSP_CUTTLEFISH_PRODUCT:-aosp_cf_riscv64_phone-trunk_staging-userdebug}\n",
        )
        local_manifest = write(
            chip / "local_manifests/eliza.xml",
            """<manifest>
  <project name="eliza" path="vendor/eliza/src">
    <linkfile src="packages/chip/sw/aosp-device/device/eliza/eliza_ai_soc/device.mk"
              dest="device/eliza/eliza_ai_soc/device.mk" />
  </project>
</manifest>
""",
        )
        chip_product = write(
            device / "eliza_ai_soc.mk",
            "$(call inherit-product, device/google/cuttlefish/vsoc_riscv64/phone/aosp_cf.mk)\n"
            "$(call inherit-product, device/eliza/eliza_ai_soc/device.mk)\n",
        )
        chip_device_mk = write(
            device / "device.mk",
            "PRODUCT_PACKAGES += some.scaffold.package\n",
        )
        chip_board = write(
            device / "BoardConfig.mk",
            "ALLOW_MISSING_DEPENDENCIES := true\n",
        )
        chip_manifest = write(
            device / "manifest.xml",
            '<manifest version="1.0" type="device"></manifest>\n',
        )
        chip_e1_vintf_fragment = write(
            device / "hal/e1_npu/vendor.eliza.e1_npu@1.0-service.xml",
            """<manifest version="1.0" type="device">
  <hal format="hidl"><name>vendor.eliza.e1_npu</name></hal>
</manifest>
""",
        )
        os_products = write(
            vendor / "AndroidProducts.mk",
            "COMMON_LUNCH_CHOICES := \\\n"
            "    eliza_cf_arm64_phone-trunk_staging-userdebug \\\n"
            "    eliza_cf_x86_64_phone-trunk_staging-userdebug \\\n"
            "    eliza_cf_riscv64_phone-trunk_staging-userdebug \\\n"
            "    eliza_openagent_ai_soc_phone-trunk_staging-userdebug\n",
        )
        os_common = write(
            vendor / "eliza_common.mk",
            "PRODUCT_PACKAGES += \\\n"
            "    Eliza \\\n"
            "    default-permissions-ai.elizaos.app.xml \\\n"
            "    privapp-permissions-ai.elizaos.app.xml\n",
        )
        openagent = write(
            vendor / "products/eliza_openagent_ai_soc_phone.mk",
            "$(call inherit-product, device/eliza/eliza_ai_soc/eliza_ai_soc.mk)\n"
            "$(call inherit-product, vendor/eliza/eliza_common.mk)\n",
        )
        patches = [
            mock.patch.object(gate, "WORKSPACE", tmp),
            mock.patch.object(gate, "CHIP_AOSP", chip),
            mock.patch.object(gate, "CHIP_DEVICE", device),
            mock.patch.object(gate, "OS_VENDOR", vendor),
            mock.patch.object(gate, "BUILD_SCRIPT", build_script),
            mock.patch.object(gate, "BOOT_SCRIPT", boot_script),
            mock.patch.object(gate, "CAPTURE_SCRIPT", capture_script),
            mock.patch.object(gate, "LOCAL_MANIFEST", local_manifest),
            mock.patch.object(gate, "CHIP_PRODUCT", chip_product),
            mock.patch.object(gate, "CHIP_DEVICE_MK", chip_device_mk),
            mock.patch.object(gate, "CHIP_BOARD", chip_board),
            mock.patch.object(gate, "CHIP_MANIFEST", chip_manifest),
            mock.patch.object(gate, "CHIP_E1_VINTF_FRAGMENT", chip_e1_vintf_fragment),
            mock.patch.object(gate, "OS_ANDROID_PRODUCTS", os_products),
            mock.patch.object(gate, "OS_COMMON", os_common),
            mock.patch.object(gate, "OS_OPENAGENT_PRODUCT", openagent),
        ]
        return patches

    def test_split_scaffold_product_blocks_launcher_objective(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            patches = self._patch_tree(tmp)
            with PatchStack(patches):
                report = gate.run_check(Namespace())
        self.assertEqual(report["status"], "blocked")
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("aosp_build_default_not_fused_eliza_chip_product", codes)
        self.assertIn("aosp_boot_flow_not_selecting_fused_product", codes)
        self.assertIn("aosp_capture_default_not_fused_eliza_product", codes)
        self.assertIn("aosp_capture_cuttlefish_default_not_eliza_product", codes)
        self.assertIn("chip_product_missing_eliza_vendor_layer", codes)
        self.assertIn("chip_product_missing_eliza_privapp_packages", codes)
        self.assertIn("local_manifest_does_not_project_os_vendor_layer", codes)
        self.assertIn("aosp_allow_missing_dependencies_enabled", codes)
        self.assertIn("chip_product_missing_active_hal_packages", codes)

    def test_fused_product_contract_passes_static_checks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            patches = self._patch_tree(tmp)
            with PatchStack(patches):
                gate.BUILD_SCRIPT.write_text(
                    'LUNCH_TARGET="eliza_openagent_ai_soc_phone-trunk_staging-userdebug"\n',
                    encoding="utf-8",
                )
                gate.BOOT_SCRIPT.write_text(
                    "aosp_product=${AOSP_PRODUCT:-eliza_openagent_ai_soc_phone-trunk_staging-userdebug}\n"
                    "aosp_cuttlefish_product=${AOSP_CUTTLEFISH_PRODUCT:-eliza_openagent_ai_soc_phone-trunk_staging-userdebug}\n",
                    encoding="utf-8",
                )
                gate.CAPTURE_SCRIPT.write_text(
                    "aosp_product=${AOSP_PRODUCT:-eliza_openagent_ai_soc_phone-trunk_staging-userdebug}\n"
                    "aosp_cuttlefish_product=${AOSP_CUTTLEFISH_PRODUCT:-eliza_cf_riscv64_phone-trunk_staging-userdebug}\n",
                    encoding="utf-8",
                )
                gate.CHIP_PRODUCT.write_text(
                    "$(call inherit-product, device/google/cuttlefish/vsoc_riscv64/phone/aosp_cf.mk)\n"
                    "$(call inherit-product, device/eliza/eliza_ai_soc/device.mk)\n"
                    "$(call inherit-product, vendor/eliza/eliza_common.mk)\n",
                    encoding="utf-8",
                )
                gate.CHIP_DEVICE_MK.write_text(
                    "PRODUCT_PACKAGES += \\\n"
                    "    Eliza \\\n"
                    "    default-permissions-ai.elizaos.app.xml \\\n"
                    "    privapp-permissions-ai.elizaos.app.xml \\\n"
                    "    vendor.eliza.e1_npu@1.0-service\n",
                    encoding="utf-8",
                )
                gate.CHIP_BOARD.write_text("# no allow missing dependencies\n", encoding="utf-8")
                gate.CHIP_MANIFEST.write_text(
                    '<manifest version="1.0" type="device"></manifest>\n',
                    encoding="utf-8",
                )
                gate.LOCAL_MANIFEST.write_text(
                    """<manifest><project name="eliza" path="vendor/eliza/src">
  <linkfile src="packages/os/android/vendor/eliza/AndroidProducts.mk" dest="vendor/eliza/AndroidProducts.mk" />
  <linkfile src="packages/os/android/vendor/eliza/eliza_common.mk" dest="vendor/eliza/eliza_common.mk" />
</project></manifest>
""",
                    encoding="utf-8",
                )
                report = gate.run_check(Namespace())
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["findings"], [])
        self.assertEqual(report["claim_boundary"], gate.CLAIM_BOUNDARY)

    def test_deprecated_local_hwcomposer_blocks_current_fcm(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            patches = self._patch_tree(tmp)
            with PatchStack(patches):
                gate.CHIP_PRODUCT.write_text(
                    "$(call inherit-product, device/google/cuttlefish/vsoc_riscv64/phone/aosp_cf.mk)\n"
                    "$(call inherit-product, device/eliza/eliza_ai_soc/device.mk)\n",
                    encoding="utf-8",
                )
                gate.CHIP_DEVICE_MK.write_text(
                    "PRODUCT_PACKAGES += \\\n"
                    "    vendor.eliza.e1_npu@1.0-service \\\n"
                    "    android.hardware.graphics.composer@2.4-service.eliza_ai_soc \\\n"
                    "    hwcomposer.eliza_ai_soc\n",
                    encoding="utf-8",
                )
                report = gate.run_check(Namespace())

        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("chip_product_packages_deprecated_hidl_hwcomposer", codes)


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
