#!/usr/bin/env python3
"""Tests for scripts/check_linux_memory_platform_contract.py."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from io import StringIO
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import check_linux_memory_platform_contract as gate  # noqa: E402


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def write_json(path: Path, payload: dict) -> Path:
    return write(path, json.dumps(payload, indent=2, sort_keys=True) + "\n")


CONTRACT = {
    "e1_chip_cpu_variant": {
        "dram": {"base": "0x80000000", "size": "0x10000000"},
        "uart": {"base": "0x10001000", "size": "0x1000", "clock_frequency_hz": 50000000, "irq": 1},
        "plic": {"base": "0x0c000000", "size": "0x04000000", "num_sources": 32},
        "clint": {"base": "0x02000000", "size": "0x00010000"},
        "interrupts": {"IRQ_TIMER": 7},
        "devices": {
            "dma": {"base": "0x10010000", "size": "0x1000", "irq": 2, "compatible": "eliza,e1-dma"},
            "npu": {"base": "0x10020000", "size": "0x1000", "irq": 3, "compatible": "eliza,e1-npu"},
            "display": {
                "base": "0x10030000",
                "size": "0x1000",
                "irq": 4,
                "compatible": "eliza,e1-display",
            },
        },
    }
}


def dts(*, android: bool = False) -> str:
    status = '\n      status = "disabled";' if android else ""
    radio = (
        ""
        if android
        else """
  wifi_pwrseq: wifi-pwrseq {
    compatible = "mmc-pwrseq-simple";
  };
  sdio_wifi@0 {
    compatible = "brcm,bcm4329-fmac";
    status = "disabled";
  };
  bluetooth {
    compatible = "brcm,bcm43438-bt";
    status = "disabled";
  };
"""
    )
    return f"""/dts-v1/;
/ {{
  #address-cells = <2>;
  #size-cells = <2>;
  chosen {{ bootargs = "console=ttyS0"; }};
  cpus {{
    cpu@0 {{
      riscv,isa = "rv64gc";
      mmu-type = "riscv,sv39";
      cpu0_intc: interrupt-controller {{ #interrupt-cells = <1>; interrupt-controller; }};
    }};
  }};
  memory@80000000 {{
    device_type = "memory";
    reg = <0x0 0x80000000 0x0 0x10000000>;
  }};
  clint@2000000 {{
    compatible = "riscv,clint0";
    reg = <0x0 0x02000000 0x0 0x00010000>;
    interrupts-extended = <&cpu0_intc 3>, <&cpu0_intc 7>;
  }};
  plic: interrupt-controller@c000000 {{
    compatible = "riscv,plic0";
    reg = <0x0 0x0c000000 0x0 0x04000000>;
    riscv,ndev = <32>;
  }};
  serial@10001000 {{
    compatible = "ns16550a";
    reg = <0x0 0x10001000 0x0 0x00001000>;
    clock-frequency = <50000000>;
    interrupts = <1>;
  }};
  dma@10010000 {{
    compatible = "eliza,e1-dma";
    reg = <0x0 0x10010000 0x0 0x00001000>;
    interrupts = <2>;{status}
  }};
  npu@10020000 {{
    compatible = "eliza,e1-npu";
    reg = <0x0 0x10020000 0x0 0x00001000>;
    interrupts = <3>;{status}
  }};
  display@10030000 {{
    compatible = "eliza,e1-display";
    reg = <0x0 0x10030000 0x0 0x00001000>;
    interrupts = <4>;{status}
  }};
{radio}
}};
"""


def manifest_with_missing_evidence() -> dict:
    return {
        "claim_boundary": "missing_evidence_manifest_only_not_linux_boot_or_dram_evidence",
        "required_evidence": [
            {
                "id": "linux_kernel_build",
                "status": "blocked_missing_external_transcript",
                "path": "docs/evidence/linux/eliza_e1_kernel_build.log",
                "blocked_marker": "docs/evidence/linux/eliza_e1_kernel_build.log.BLOCKED",
                "producer": "capture kernel build",
            }
        ],
        "forbidden_pass_markers": ["placeholder", "status=FAIL"],
    }


class LinuxMemoryPlatformContractTests(unittest.TestCase):
    def _patch_tree(self, tmp: Path):
        write_json(tmp / "sw/platform/e1_platform_contract.json", CONTRACT)
        write(tmp / "sw/linux/dts/eliza-e1.dts", dts())
        write(
            tmp / "sw/aosp-device/device/eliza/eliza_ai_soc/dts/eliza-e1-android.dts",
            dts(android=True),
        )
        write(
            tmp / "sw/platform/generated/e1-platform.dtsi",
            """
memory@80000000 { reg = <0x0 0x80000000 0x0 0x10000000>; };
serial@10001000 { compatible = "ns16550a"; };
plic { riscv,ndev = <32>; };
""",
        )
        write_json(
            tmp / "docs/evidence/linux-memory-platform-missing-evidence.json",
            manifest_with_missing_evidence(),
        )
        write(
            tmp / "docs/evidence/linux/eliza_e1_kernel_build.log.BLOCKED", "reason: not captured\n"
        )
        return [
            mock.patch.object(gate, "ROOT", tmp),
            mock.patch.object(gate, "CONTRACT", tmp / "sw/platform/e1_platform_contract.json"),
            mock.patch.object(gate, "LINUX_DTS", tmp / "sw/linux/dts/eliza-e1.dts"),
            mock.patch.object(
                gate,
                "AOSP_DTS",
                tmp / "sw/aosp-device/device/eliza/eliza_ai_soc/dts/eliza-e1-android.dts",
            ),
            mock.patch.object(
                gate, "GENERATED_DTSI", tmp / "sw/platform/generated/e1-platform.dtsi"
            ),
            mock.patch.object(
                gate,
                "MANIFEST",
                tmp / "docs/evidence/linux-memory-platform-missing-evidence.json",
            ),
            mock.patch.object(
                gate, "REPORT", tmp / "build/reports/linux_memory_platform_contract.json"
            ),
            mock.patch.object(gate.shutil, "which", lambda name: None),
        ]

    def test_missing_evidence_blocks_even_when_static_contract_matches(self) -> None:
        with (
            tempfile.TemporaryDirectory() as tmpdir,
            PatchStack(self._patch_tree(Path(tmpdir))),
        ):
            report, rc = gate.build_report()

        self.assertEqual(rc, 0)
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["errors"], [])
        self.assertIn("linux_kernel_build", report["blockers"][0])

    def test_stale_linux_and_aosp_dts_fail_static_contract(self) -> None:
        with (
            tempfile.TemporaryDirectory() as tmpdir,
            PatchStack(self._patch_tree(Path(tmpdir))),
        ):
            gate.LINUX_DTS.write_text('compatible = "e1,npu-1.0";\n', encoding="utf-8")
            gate.AOSP_DTS.write_text("reg = <0x0 0x40000000 0x0 0x1000>;\n", encoding="utf-8")
            report, rc = gate.build_report()

        self.assertEqual(rc, 1)
        self.assertEqual(report["status"], "fail")
        self.assertTrue(any("stale token e1,npu-1.0" in error for error in report["errors"]))
        self.assertTrue(any("stale token 0x40000000" in error for error in report["errors"]))

    def test_fail_output_does_not_emit_blocked_marker_that_masks_errors(self) -> None:
        with (
            tempfile.TemporaryDirectory() as tmpdir,
            PatchStack(self._patch_tree(Path(tmpdir))),
        ):
            gate.LINUX_DTS.write_text('compatible = "e1,npu-1.0";\n', encoding="utf-8")
            stdout = StringIO()
            with mock.patch("sys.stdout", stdout):
                rc = gate.main([])

        self.assertEqual(rc, 1)
        output = stdout.getvalue()
        self.assertIn("STATUS: FAIL linux_memory_platform_contract", output)
        self.assertIn("EVIDENCE-GAP:", output)
        self.assertNotIn("BLOCKED:", output)

    def test_contract_passes_when_evidence_files_exist(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            with PatchStack(self._patch_tree(tmp)):
                write(
                    gate.ROOT / "docs/evidence/linux/eliza_e1_kernel_build.log",
                    "eliza-evidence: status=PASS\nkernel build transcript\n",
                )
                report, rc = gate.build_report()

        self.assertEqual(rc, 0)
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["errors"], [])
        self.assertEqual(report["blockers"], [])


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
