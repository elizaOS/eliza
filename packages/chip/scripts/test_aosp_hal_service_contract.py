#!/usr/bin/env python3
"""Tests for scripts/check_aosp_hal_service_contract.py."""

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

import check_aosp_hal_service_contract as gate  # noqa: E402


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


MANIFEST_WITH_E1 = """<manifest version="1.0" type="device">
  <hal format="hidl">
    <name>vendor.eliza.e1_npu</name>
    <transport>hwbinder</transport>
    <version>1.0</version>
    <interface><name>IE1Npu</name><instance>default</instance></interface>
  </hal>
</manifest>
"""


class AospHalServiceContractTests(unittest.TestCase):
    def _patch_tree(self, tmp: Path):
        device = tmp / "sw/aosp-device/device/eliza/eliza_ai_soc"
        hal_dir = device / "hal/e1_npu"
        sepolicy = device / "sepolicy"
        device_mk = write(device / "device.mk", "PRODUCT_PACKAGES += Eliza\n")
        board = write(
            device / "BoardConfig.mk",
            "DEVICE_MANIFEST_FILE += device/eliza/eliza_ai_soc/eliza_e1.xml\n",
        )
        init_rc = write(device / "init.eliza.rc", "setprop vendor.e1_npu.ready 0\n")
        device_manifest = write(
            device / "manifest.xml", '<manifest version="1.0" type="device"></manifest>\n'
        )
        e1_manifest = write(device / "eliza_e1.xml", MANIFEST_WITH_E1)
        hal_bp = write(
            hal_dir / "Android.bp",
            'cc_binary { name: "vendor.eliza.e1_npu@1.0-service", srcs: ["service.cpp"] }\n',
        )
        hal_rc = write(
            hal_dir / "vendor.eliza.e1_npu@1.0-service.rc",
            """service vendor.e1_npu /vendor/bin/hw/vendor.eliza.e1_npu@1.0-service
    interface vendor.eliza.e1_npu@1.0::IE1Npu default
    class hal
    disabled
    oneshot
""",
        )
        hal_impl = write(
            hal_dir / "E1Npu.h",
            "class E1Npu { static constexpr off_t kResultOffset = 0x10; };\n",
        )
        file_contexts = write(
            sepolicy / "file_contexts",
            "/vendor/bin/hw/vendor\\.eliza\\.e1_npu@1\\.0-service u:object_r:hal_e1_npu_default_exec:s0\n"
            "/dev/e1-npu u:object_r:e1_npu_device:s0\n",
        )
        e1_te = write(
            sepolicy / "e1_npu.te",
            "type hal_e1_npu_default, domain;\ninit_daemon_domain(hal_e1_npu_default)\n",
        )
        contract = write(
            tmp / "sw/linux/drivers/e1/e1_platform_contract.h",
            "#define E1_NPU_RESULT_OFFSET 0x08u\n",
        )
        patches = [
            mock.patch.object(gate, "ROOT", tmp),
            mock.patch.object(gate, "DEVICE", device),
            mock.patch.object(gate, "DEVICE_MK", device_mk),
            mock.patch.object(gate, "BOARD_CONFIG", board),
            mock.patch.object(gate, "INIT_RC", init_rc),
            mock.patch.object(gate, "DEVICE_MANIFEST", device_manifest),
            mock.patch.object(gate, "E1_MANIFEST", e1_manifest),
            mock.patch.object(gate, "HAL_DIR", hal_dir),
            mock.patch.object(gate, "HAL_BP", hal_bp),
            mock.patch.object(gate, "HAL_RC", hal_rc),
            mock.patch.object(gate, "HAL_IMPL", hal_impl),
            mock.patch.object(gate, "SEPOLICY", sepolicy),
            mock.patch.object(gate, "FILE_CONTEXTS", file_contexts),
            mock.patch.object(gate, "E1_NPU_TE", e1_te),
            mock.patch.object(gate, "LINUX_CONTRACT_HEADER", contract),
            mock.patch.object(gate, "REPORT", tmp / "build/reports/aosp_hal_service_contract.json"),
        ]
        return patches

    def test_declared_but_unstartable_hal_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir))
            with PatchStack(patches):
                report = gate.run_check(Namespace())
        self.assertEqual(report["status"], "blocked")
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("aosp_e1_npu_vintf_declared_but_service_not_packaged", codes)
        self.assertIn("aosp_hwcomposer_service_not_packaged", codes)
        self.assertIn("aosp_board_includes_e1_vintf_without_package", codes)
        self.assertIn("aosp_init_never_enables_e1_npu_hal", codes)
        self.assertIn("aosp_e1_npu_service_disabled_by_default", codes)
        self.assertIn("aosp_e1_npu_service_oneshot", codes)
        self.assertIn("aosp_e1_npu_ready_property_context_missing", codes)
        self.assertIn("aosp_e1_npu_hwservice_context_missing", codes)
        self.assertIn("aosp_e1_npu_selinux_lacks_hal_server_domain", codes)
        self.assertIn("aosp_e1_npu_hal_result_offset_mismatch", codes)
        self.assertIn("aosp_e1_npu_hidl_interface_not_packaged", codes)

    def test_packaged_startable_hal_contract_passes_static_checks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir))
            with PatchStack(patches):
                gate.DEVICE_MK.write_text(
                    "PRODUCT_PACKAGES += \\\n"
                    "    vendor.eliza.e1_npu@1.0-service \\\n"
                    "    android.hardware.graphics.composer@2.4-service.eliza_ai_soc\n",
                    encoding="utf-8",
                )
                gate.INIT_RC.write_text(
                    "setprop vendor.e1_npu.ready 0\n"
                    "on post-fs\n"
                    "    setprop vendor.e1_npu.ready 1\n",
                    encoding="utf-8",
                )
                gate.HAL_RC.write_text(
                    """service vendor.e1_npu /vendor/bin/hw/vendor.eliza.e1_npu@1.0-service
    interface vendor.eliza.e1_npu@1.0::IE1Npu default
    class hal
""",
                    encoding="utf-8",
                )
                gate.HAL_IMPL.write_text(
                    "class E1Npu { static constexpr off_t kResultOffset = 0x08; };\n",
                    encoding="utf-8",
                )
                gate.HAL_BP.write_text(
                    'cc_binary { name: "vendor.eliza.e1_npu@1.0-service", srcs: ["service.cpp", "IE1Npu.hal"] }\n',
                    encoding="utf-8",
                )
                write(
                    gate.SEPOLICY / "property_contexts",
                    "vendor.e1_npu.ready u:object_r:vendor_e1_npu_prop:s0\n",
                )
                write(
                    gate.SEPOLICY / "hwservice_contexts",
                    "vendor.eliza.e1_npu::IE1Npu u:object_r:hal_e1_npu_hwservice:s0\n",
                )
                gate.E1_NPU_TE.write_text(
                    "type hal_e1_npu_default, domain;\n"
                    "hal_server_domain(hal_e1_npu_default, hal_e1_npu)\n",
                    encoding="utf-8",
                )
                report = gate.run_check(Namespace())
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["findings"], [])
        self.assertEqual(report["claim_boundary"], gate.CLAIM_BOUNDARY)


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
