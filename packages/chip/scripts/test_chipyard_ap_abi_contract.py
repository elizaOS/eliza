#!/usr/bin/env python3
"""Tests for scripts/check_chipyard_ap_abi_contract.py."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import check_chipyard_ap_abi_contract as gate  # noqa: E402


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


CONTRACT = {
    "e1_chip_cpu_variant": {
        "target_kind": "linux_capable_soc_projection",
        "has_cpu": True,
        "timebase_frequency_hz": 10000000,
        "plic": {"num_sources": 32},
        "uart": {"base": "0x10001000", "size": "0x1000"},
        "devices": {
            "dma": {"base": "0x10010000", "size": "0x1000", "compatible": "eliza,e1-dma"},
            "npu": {"base": "0x10020000", "size": "0x1000", "compatible": "eliza,e1-npu"},
            "display": {
                "base": "0x10030000",
                "size": "0x1000",
                "compatible": "eliza,e1-display",
            },
        },
    }
}


CURRENT_CHIPYARD_DTS = """/dts-v1/;
/ {
  compatible = "ucb-bar,chipyard-dev";
  model = "ucb-bar,chipyard";
  cpus { timebase-frequency = <500000>; };
  soc {
    interrupt-controller@c000000 { compatible = "riscv,plic0"; riscv,ndev = <3>; };
    serial@10020000 {
      compatible = "sifive,uart0";
      reg = <0x10020000 0x1000>;
    };
  };
};
"""


E1_DTS = """/dts-v1/;
/ {
  compatible = "eliza,e1-board", "eliza,e1";
  cpus { timebase-frequency = <10000000>; };
  soc {
    interrupt-controller@c000000 { compatible = "riscv,plic0"; riscv,ndev = <32>; };
    serial@10001000 {
      compatible = "ns16550a", "e1,uart-1.0";
      reg = <0x10001000 0x1000>;
    };
    dma@10010000 { compatible = "eliza,e1-dma"; reg = <0x10010000 0x1000>; };
    npu@10020000 { compatible = "eliza,e1-npu"; reg = <0x10020000 0x1000>; };
    display@10030000 { compatible = "eliza,e1-display"; reg = <0x10030000 0x1000>; };
  };
};
"""


class ChipyardApAbiContractTests(unittest.TestCase):
    def _patch_tree(self, tmp: Path):
        generated_dts = write(
            tmp / "build/chipyard/eliza_rocket/eliza-e1.dts", CURRENT_CHIPYARD_DTS
        )
        source_dts = write(
            tmp
            / "build/chipyard/eliza_rocket/generated-src/chipyard.harness.TestHarness.ElizaRocketConfig.dts",
            CURRENT_CHIPYARD_DTS,
        )
        manifest = write(
            tmp / "build/chipyard/eliza_rocket/ElizaRocketConfig.manifest.json",
            json.dumps({"artifacts": {"dts": "build/chipyard/eliza_rocket/eliza-e1.dts"}}),
        )
        contract = write(
            tmp / "sw/platform/e1_platform_contract.json",
            json.dumps(CONTRACT),
        )
        static_e1_dts = write(tmp / "sw/linux/dts/eliza-e1.dts", E1_DTS)
        patches = [
            mock.patch.object(gate, "ROOT", tmp),
            mock.patch.object(gate, "BUILD", tmp / "build/chipyard/eliza_rocket"),
            mock.patch.object(gate, "GENERATED_DTS", generated_dts),
            mock.patch.object(gate, "GENERATED_SOURCE_DTS", source_dts),
            mock.patch.object(gate, "IMPORT_MANIFEST", manifest),
            mock.patch.object(gate, "PLATFORM_CONTRACT", contract),
            mock.patch.object(gate, "STATIC_E1_DTS", static_e1_dts),
        ]
        return patches

    def test_current_chipyard_reference_dts_blocks_e1_abi_claim(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir))
            with PatchStack(patches):
                report = gate.run_check(Namespace())
        self.assertEqual(report["status"], "blocked")
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("generated_ap_dts_identifies_chipyard_not_e1", codes)
        self.assertIn("generated_ap_dts_missing_e1_root_compatible", codes)
        self.assertIn("generated_ap_uart_region_mismatch", codes)
        self.assertIn("generated_ap_uart_collides_with_e1_npu_region", codes)
        self.assertIn("generated_ap_dts_missing_e1_devices", codes)
        self.assertIn("generated_ap_timebase_mismatch", codes)
        self.assertIn("generated_ap_plic_source_count_mismatch", codes)
        self.assertIn("generated_ap_console_driver_mismatch", codes)
        self.assertIn("generated_manifest_labels_chipyard_dts_as_eliza_e1", codes)

    def test_e1_compatible_generated_dts_passes_static_abi_check(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir))
            with PatchStack(patches):
                gate.GENERATED_DTS.write_text(E1_DTS, encoding="utf-8")
                gate.GENERATED_SOURCE_DTS.write_text(E1_DTS, encoding="utf-8")
                report = gate.run_check(Namespace())
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["findings"], [])
        self.assertEqual(report["claim_boundary"], gate.CLAIM_BOUNDARY)
        self.assertRegex(report["generated_utc"], r"^\d{4}-\d{2}-\d{2}T")
        for flag in gate.FALSE_CLAIM_FLAGS:
            self.assertIs(report[flag], False)

    def test_static_abi_report_never_promotes_boot_or_release_claims(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir))
            with PatchStack(patches):
                report = gate.run_check(Namespace())
        for flag in gate.FALSE_CLAIM_FLAGS:
            self.assertIs(report[flag], False)


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
