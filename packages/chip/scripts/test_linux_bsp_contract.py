#!/usr/bin/env python3
"""Tests for scripts/check_linux_bsp_contract.py."""

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

import check_linux_bsp_contract as gate  # noqa: E402


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


STALE_FRAGMENT = """# Kernel config fragment for the OpenPhone hello BSP.
# external Linux tree that has imported sw/linux/drivers/openphone/
CONFIG_OPENPHONE_HELLO=m
CONFIG_OPENPHONE_HELLO_NPU=m
CONFIG_OPENPHONE_HELLO_DMA=m
CONFIG_ASHMEM=y
CONFIG_ION=y
"""


GOOD_FRAGMENT = """# Kernel config fragment for the Eliza e1 BSP.
CONFIG_ELIZA_E1_BSP=m
CONFIG_ELIZA_E1_NPU=m
CONFIG_ELIZA_E1_DMA=m
CONFIG_ELIZA_E1_DISPLAY=m
CONFIG_ELIZA_E1_GPIO=m
CONFIG_ANDROID_BINDER_IPC=y
CONFIG_ANDROID_BINDERFS=y
CONFIG_ANDROID_BINDER_DEVICES="binder,hwbinder,vndbinder"
"""


DTS = """/dts-v1/;
/ {
  soc {
    dma@10010000 { compatible = "eliza,e1-dma"; };
    npu@10020000 { compatible = "eliza,e1-npu"; };
    display@10030000 { compatible = "eliza,e1-display"; };
    gpio@10000000 { compatible = "eliza,e1-gpio"; };
  };
};
"""


REDUCED_E1_KCONFIG = """menuconfig ELIZA_E1_BSP
config ELIZA_E1_NPU
config ELIZA_E1_DMA
"""


FULL_ELIZA_KCONFIG = """menuconfig ELIZA_E1
config ELIZA_E1_NPU
config ELIZA_E1_DMA
config ELIZA_E1_DISPLAY
config ELIZA_E1_GPIO
"""


DISPLAY_BINDING = """# SPDX-License-Identifier: (GPL-2.0-only OR BSD-2-Clause)
properties:
  interrupt-names:
    items:
      - const: IRQ_VSYNC
  eliza,mode: true
  eliza,format: true
  eliza,fb-base: true
"""


class LinuxBspContractTests(unittest.TestCase):
    def _patch_tree(self, tmp: Path):
        fragment = write(tmp / "sw/linux/configs/eliza_e1.fragment", STALE_FRAGMENT)
        import_script = write(
            tmp / "sw/linux/scripts/import-linux-bsp.sh",
            "rsync -a $bsp/drivers/e1/ $linux/drivers/misc/eliza-e1/\n",
        )
        capture_script = write(
            tmp / "sw/linux/scripts/capture-linux-bsp-evidence.sh",
            'grep -R "CONFIG_ELIZA_E1_NPU" .config && grep -R "CONFIG_ELIZA_E1_DMA" .config\n',
        )
        dts = write(tmp / "sw/linux/dts/eliza-e1.dts", DTS)
        display_binding = write(
            tmp / "sw/linux/Documentation/devicetree/bindings/eliza/eliza,e1-display.yaml",
            DISPLAY_BINDING,
        )
        drivers_e1 = tmp / "sw/linux/drivers/e1"
        drivers_eliza = tmp / "sw/linux/drivers/eliza"
        write(drivers_e1 / "Kconfig", REDUCED_E1_KCONFIG)
        write(drivers_eliza / "Kconfig", FULL_ELIZA_KCONFIG)
        write(
            tmp / "docs/evidence/linux/eliza_e1_kernel_build.log.BLOCKED",
            "required_markers: openphone-evidence\n",
        )
        patches = [
            mock.patch.object(gate, "ROOT", tmp),
            mock.patch.object(gate, "FRAGMENT", fragment),
            mock.patch.object(gate, "IMPORT_SCRIPT", import_script),
            mock.patch.object(gate, "CAPTURE_SCRIPT", capture_script),
            mock.patch.object(gate, "DTS", dts),
            mock.patch.object(gate, "DISPLAY_BINDING", display_binding),
            mock.patch.object(gate, "DRIVERS_E1", drivers_e1),
            mock.patch.object(gate, "DRIVERS_ELIZA", drivers_eliza),
            mock.patch.object(gate, "REPORT", tmp / "build/reports/linux_bsp_contract.json"),
        ]
        return patches

    def test_stale_openphone_reduced_bsp_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir))
            with PatchStack(patches):
                report = gate.run_check(Namespace())
        self.assertEqual(report["status"], "blocked")
        for key in (
            "phone_claim_allowed",
            "release_claim_allowed",
            "linux_boot_claim_allowed",
            "android_bsp_claim_allowed",
            "display_driver_claim_allowed",
            "drm_kms_claim_allowed",
            "display_runtime_binding_claim_allowed",
            "simple_framebuffer_runtime_claim_allowed",
            "panel_dcs_init_claim_allowed",
            "dsi_host_claim_allowed",
        ):
            self.assertIs(report.get(key), False)
        self.assertIn("generated_utc", report)
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("linux_kernel_fragment_has_stale_openphone_contract", codes)
        self.assertIn("linux_kernel_fragment_missing_eliza_base_symbols", codes)
        self.assertIn("linux_kernel_fragment_missing_dts_driver_symbols", codes)
        self.assertIn("linux_display_dts_missing_programming_contract", codes)
        self.assertIn("linux_kernel_fragment_has_legacy_android_options", codes)
        self.assertIn("linux_import_uses_reduced_driver_tree_while_full_tree_exists", codes)
        self.assertIn("linux_capture_does_not_verify_full_dts_driver_set", codes)
        self.assertIn("linux_blocked_evidence_uses_openphone_markers", codes)

    def test_aligned_eliza_bsp_contract_passes_static_checks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir))
            with PatchStack(patches):
                gate.FRAGMENT.write_text(GOOD_FRAGMENT, encoding="utf-8")
                gate.IMPORT_SCRIPT.write_text(
                    "rsync -a $bsp/drivers/eliza/ $linux/drivers/misc/eliza/\n",
                    encoding="utf-8",
                )
                gate.CAPTURE_SCRIPT.write_text(
                    'grep -R "CONFIG_ELIZA_E1_NPU" .config\n'
                    'grep -R "CONFIG_ELIZA_E1_DMA" .config\n'
                    'grep -R "CONFIG_ELIZA_E1_DISPLAY" .config\n'
                    'grep -R "CONFIG_ELIZA_E1_GPIO" .config\n',
                    encoding="utf-8",
                )
                blocked = gate.ROOT / "docs/evidence/linux/eliza_e1_kernel_build.log.BLOCKED"
                blocked.write_text("required_markers: eliza-evidence\n", encoding="utf-8")
                gate.DTS.write_text(
                    """/dts-v1/;
/ {
  soc {
    dma@10010000 { compatible = "eliza,e1-dma"; };
    npu@10020000 { compatible = "eliza,e1-npu"; };
    display@10030000 {
      compatible = "eliza,e1-display";
      interrupt-names = "IRQ_VSYNC";
      eliza,mode = <0x050002d0>;
      eliza,format = <0x34325258>;
      eliza,fb-base = <0x80000000>;
    };
    gpio@10000000 { compatible = "eliza,e1-gpio"; };
  };
};
""",
                    encoding="utf-8",
                )
                report = gate.run_check(Namespace())
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["findings"], [])
        self.assertEqual(report["claim_boundary"], gate.CLAIM_BOUNDARY)
        self.assertIn("generated_utc", report)
        for key in (
            "phone_claim_allowed",
            "release_claim_allowed",
            "linux_boot_claim_allowed",
            "android_bsp_claim_allowed",
            "display_driver_claim_allowed",
            "drm_kms_claim_allowed",
            "display_runtime_binding_claim_allowed",
            "simple_framebuffer_runtime_claim_allowed",
            "panel_dcs_init_claim_allowed",
            "dsi_host_claim_allowed",
        ):
            self.assertIs(report.get(key), False)


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
