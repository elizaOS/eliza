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
        product_mk = write(
            device / "eliza_ai_soc.mk",
            "$(call inherit-product, device/google/cuttlefish/vsoc_riscv64/phone/aosp_cf.mk)\n",
        )
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
            "// stub fail-closed NOT_SUPPORTED\n"
            "class E1Npu { static constexpr off_t kResultOffset = 0x10; };\n",
        )
        hal_impl_cc = write(
            hal_dir / "E1Npu.cpp",
            "// missing real /dev/e1-npu open/read path\n",
        )
        hal_uapi = write(
            hal_dir / "E1NpuUapi.h",
            "// missing ioctl ABI\n",
        )
        hal_interface = write(
            hal_dir / "1.0/IE1Npu.hal",
            "// Status: stub. returns NOT_SUPPORTED when missing node.\n",
        )
        hal_interface_bp = write(
            hal_dir / "1.0/Android.bp",
            'hidl_interface { name: "broken.e1_npu@1.0", srcs: ["IE1Npu.hal"] }\n',
        )
        hwc_dir = device / "hal/hwcomposer"
        hwc_bp = write(
            hwc_dir / "Android.bp",
            "// hwcomposer v0 - framebuffer-only stub\n",
        )
        hwc_impl = write(
            hwc_dir / "hwcomposer.cpp",
            "d->base.getFunction = nullptr; // no GLES no Vulkan no HW overlays\n",
        )
        sim_bp = write(
            device / "hal/e1_npu_sim/Android.bp",
            "// Cuttlefish software-simulator; same service name as the real HAL\n",
        )
        sim_impl = write(
            device / "hal/e1_npu_sim/E1NpuSim.h",
            "// software-simulator implementation\n",
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
        linux_uapi = write(
            tmp / "sw/linux/drivers/e1/e1-npu-uapi.h",
            "struct e1_npu_contract {};\n"
            "struct e1_npu_cmd {};\n"
            "struct e1_npu_gemm_s8 {};\n"
            "#define E1_NPU_IOC_RUN_CMD x\n"
            "#define E1_NPU_IOC_RUN_GEMM_S8 x\n"
            "#define E1_NPU_IOC_GET_CONTRACT x\n"
            "#define E1_NPU_OP_RELU4_S8 10u\n"
            "#define E1_NPU_SCRATCH_BYTES 64u\n",
        )
        patches = [
            mock.patch.object(gate, "ROOT", tmp),
            mock.patch.object(gate, "DEVICE", device),
            mock.patch.object(gate, "ELIZA_PRODUCT_MK", product_mk),
            mock.patch.object(gate, "DEVICE_MK", device_mk),
            mock.patch.object(gate, "BOARD_CONFIG", board),
            mock.patch.object(gate, "INIT_RC", init_rc),
            mock.patch.object(gate, "DEVICE_MANIFEST", device_manifest),
            mock.patch.object(gate, "E1_MANIFEST", e1_manifest),
            mock.patch.object(gate, "HAL_DIR", hal_dir),
            mock.patch.object(gate, "HAL_BP", hal_bp),
            mock.patch.object(gate, "HAL_RC", hal_rc),
            mock.patch.object(gate, "HAL_IMPL", hal_impl),
            mock.patch.object(gate, "HAL_IMPL_CC", hal_impl_cc),
            mock.patch.object(gate, "HAL_UAPI", hal_uapi),
            mock.patch.object(gate, "HAL_INTERFACE", hal_interface),
            mock.patch.object(gate, "HAL_INTERFACE_BP", hal_interface_bp),
            mock.patch.object(gate, "HWC_DIR", hwc_dir),
            mock.patch.object(gate, "HWC_BP", hwc_bp),
            mock.patch.object(gate, "HWC_IMPL", hwc_impl),
            mock.patch.object(gate, "SIM_HAL_BP", sim_bp),
            mock.patch.object(gate, "SIM_HAL_IMPL", sim_impl),
            mock.patch.object(gate, "SEPOLICY", sepolicy),
            mock.patch.object(gate, "FILE_CONTEXTS", file_contexts),
            mock.patch.object(gate, "E1_NPU_TE", e1_te),
            mock.patch.object(gate, "LINUX_CONTRACT_HEADER", contract),
            mock.patch.object(gate, "LINUX_NPU_UAPI_HEADER", linux_uapi),
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
        self.assertIn("aosp_board_includes_e1_vintf_without_package", codes)
        self.assertIn("aosp_init_never_enables_e1_npu_hal", codes)
        self.assertIn("aosp_e1_npu_service_disabled_by_default", codes)
        self.assertIn("aosp_e1_npu_service_oneshot", codes)
        self.assertIn("aosp_e1_npu_ready_property_context_missing", codes)
        self.assertIn("aosp_e1_npu_hwservice_context_missing", codes)
        self.assertIn("aosp_e1_npu_selinux_lacks_hal_server_domain", codes)
        self.assertIn("aosp_e1_npu_hal_result_offset_mismatch", codes)
        self.assertIn("aosp_e1_npu_hidl_interface_not_packaged", codes)
        self.assertIn("aosp_e1_npu_hal_not_fail_closed_to_kernel_node", codes)
        self.assertIn("aosp_cuttlefish_sim_hal_not_separated_from_real_product", codes)

    def test_packaged_startable_hal_contract_passes_static_checks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir))
            with PatchStack(patches):
                gate.DEVICE_MK.write_text(
                    "PRODUCT_PACKAGES += \\\n    vendor.eliza.e1_npu@1.0-service\n",
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
                    'static constexpr const char* kDevicePath = "/dev/e1-npu";\n'
                    "class E1Npu { static constexpr off_t kResultOffset = 0x08; };\n",
                    encoding="utf-8",
                )
                gate.HAL_IMPL_CC.write_text(
                    "Status::NOT_SUPPORTED;\n"
                    "int flags = O_RDWR | O_CLOEXEC;\n"
                    "E1_NPU_IOC_GET_CONTRACT;\n"
                    "E1_NPU_IOC_RUN_CMD;\n"
                    "E1_NPU_IOC_RUN_GEMM_S8;\n"
                    "E1_NPU_OP_RELU4_S8;\n"
                    "0x800700fcu;\n"
                    "0x00070000u;\n"
                    "kExpectedGemm[4] = {-44, 8, 139, -54};\n"
                    "contract.npu_base;\n",
                    encoding="utf-8",
                )
                gate.HAL_UAPI.write_text(
                    "struct e1_npu_contract {};\n"
                    "struct e1_npu_cmd {};\n"
                    "struct e1_npu_gemm_s8 {};\n"
                    "#define E1_NPU_IOC_RUN_CMD _IOWR(E1_NPU_IOC_MAGIC, 0x01, struct e1_npu_cmd)\n"
                    "#define E1_NPU_SCRATCH_BYTES 64u\n"
                    "#define E1_NPU_IOC_GET_CONTRACT _IOR(E1_NPU_IOC_MAGIC, 0x06, struct e1_npu_contract)\n"
                    "#define E1_NPU_IOC_RUN_GEMM_S8 _IOWR(E1_NPU_IOC_MAGIC, 0x02, struct e1_npu_gemm_s8)\n"
                    "#define E1_NPU_OP_RELU4_S8 10u\n",
                    encoding="utf-8",
                )
                gate.HAL_INTERFACE.write_text(
                    "interface IE1Npu { smoke() generates (Status status, uint32_t identity); };\n",
                    encoding="utf-8",
                )
                gate.HAL_INTERFACE_BP.write_text(
                    'hidl_interface { name: "vendor.eliza.e1_npu@1.0", '
                    'root: "vendor.eliza.e1_npu", srcs: ["types.hal", "IE1Npu.hal"] }\n',
                    encoding="utf-8",
                )
                gate.HWC_BP.write_text(
                    'cc_binary { name: "android.hardware.graphics.composer@2.4-service.eliza_ai_soc" }\n',
                    encoding="utf-8",
                )
                gate.HWC_IMPL.write_text(
                    'const char* fb = "/dev/graphics/fb0";\n'
                    "int a = FBIOGET_VSCREENINFO;\n"
                    "int b = FBIOGET_FSCREENINFO;\n",
                    encoding="utf-8",
                )
                gate.SIM_HAL_BP.write_text(
                    'cc_binary { name: "vendor.eliza.e1_npu@1.0-service.sim" }\n',
                    encoding="utf-8",
                )
                gate.SIM_HAL_IMPL.write_text(
                    "class E1NpuSim { static constexpr uint32_t kSimulatedIdentity = 0xE11A0001u; };\n",
                    encoding="utf-8",
                )
                gate.SIM_HAL_RC.write_text(
                    "service vendor.e1_npu_sim /vendor/bin/hw/vendor.eliza.e1_npu@1.0-service.sim\n",
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
        self.assertTrue(report["evidence"]["inherits_cuttlefish_phone"])

    def test_deprecated_hidl_hwcomposer_package_blocks_current_fcm(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir))
            with PatchStack(patches):
                gate.DEVICE_MK.write_text(
                    "PRODUCT_PACKAGES += \\\n"
                    "    vendor.eliza.e1_npu@1.0-service \\\n"
                    "    android.hardware.graphics.composer@2.4-service.eliza_ai_soc \\\n"
                    "    hwcomposer.eliza_ai_soc\n",
                    encoding="utf-8",
                )
                report = gate.run_check(Namespace())

        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("aosp_hwcomposer_deprecated_hidl_service_packaged", codes)


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
