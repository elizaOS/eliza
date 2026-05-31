#!/usr/bin/env python3
"""Tests for the unified verification coverage + FPGA-lane gates.

Covers merge_coverage, check_coverage_holes (registry-missing fail-closed),
check_fpga_sim_alignment, and the restored waveform-debug / software-bsp-firmware
policy gates.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import check_coverage_holes as holes  # noqa: E402
import check_fpga_sim_alignment as align  # noqa: E402
import check_interrupt_controller as intc  # noqa: E402
import check_iopmp_rtl as iopmp  # noqa: E402
import check_mcie as mcie  # noqa: E402
import check_software_bsp_firmware_ai_policy as bsp  # noqa: E402
import check_waveform_debug_policy as wave  # noqa: E402
import merge_coverage as merge  # noqa: E402

COCOTB_SUMMARY = {
    "schema": merge.COCOTB_SCHEMA,
    "status": "passed",
    "blocks": {
        "npu": {
            "bins_declared": 4,
            "bins_hit": 4,
            "hits": 10,
            "missing_required_classes": [],
            "cocotb_coverage_available": True,
        }
    },
}
FORMAL_MANIFEST = {
    "schema": merge.FORMAL_SCHEMA,
    "mode": "sby-shallow-top",
    "release_claim": "strict_requires_sby_and_deep_top",
    "entries": {"e1_dma": {"status": "pass", "evidence_class": "sby_bmc"}},
}
CDC_MANIFEST = {
    "schema": merge.CDC_SCHEMA,
    "status": "blocked",
    "claim_boundary": "intent_manifest_only_not_cdc_rdc_signoff",
    "tasks": {
        "reset_sync": {
            "status": "pass",
            "bound_module": "e1_reset_sync",
            "property_pack": "verify/properties/reset_properties.sv",
            "claim_boundary": "intent_manifest_only_not_cdc_rdc_signoff",
        }
    },
}


def write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload), encoding="utf-8")


class MergeCoverageTests(unittest.TestCase):
    def _run(self, tmp: Path, cdc: dict | None) -> dict:
        cocotb = tmp / "summary.json"
        formal = tmp / "formal.json"
        out = tmp / "merged.json"
        write_json(cocotb, COCOTB_SUMMARY)
        write_json(formal, FORMAL_MANIFEST)
        argv = ["--cocotb", str(cocotb), "--formal", str(formal), "--out", str(out)]
        if cdc is not None:
            cdc_path = tmp / "cdc.json"
            write_json(cdc_path, cdc)
            argv += ["--cdc", str(cdc_path)]
        else:
            argv += ["--cdc", str(tmp / "absent.json")]
        rc = merge.main(argv)
        report = json.loads(out.read_text())
        return {"rc": rc, "report": report}

    def test_merge_joins_blocks_and_properties(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as raw:
            result = self._run(Path(raw), CDC_MANIFEST)
        self.assertEqual(result["rc"], 0)
        report = result["report"]
        self.assertEqual(report["schema"], "eliza.verification_coverage.v1")
        self.assertIn("npu", report["blocks"])
        self.assertIn("e1_dma", report["blocks"])
        self.assertEqual(report["cdc_rdc_properties"]["reset_sync"]["status"], "pass")

    def test_merge_fails_when_formal_missing(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as raw:
            tmp = Path(raw)
            cocotb = tmp / "summary.json"
            out = tmp / "merged.json"
            write_json(cocotb, COCOTB_SUMMARY)
            rc = merge.main(
                ["--cocotb", str(cocotb), "--formal", str(tmp / "nope.json"), "--out", str(out)]
            )
        self.assertEqual(rc, 1)

    def test_merge_cdc_optional_when_absent(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as raw:
            result = self._run(Path(raw), None)
        self.assertEqual(result["rc"], 0)


class CoverageHolesTests(unittest.TestCase):
    def test_registry_missing_fails_closed(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as raw:
            tmp = Path(raw)
            errors: list[str] = []
            ids = holes.load_registry_ids(tmp / "no-registry", errors)
            self.assertIsNone(ids)
            self.assertTrue(any("registry missing" in e for e in errors))

    def test_block_has_evidence_logic(self) -> None:
        self.assertTrue(
            holes.block_has_evidence({"cocotb": {"missing_required_classes": [], "bins_hit": 2}})
        )
        self.assertTrue(holes.block_has_evidence({"formal": {"status": "pass"}}))
        self.assertFalse(holes.block_has_evidence({"formal": {"status": "fail"}}))
        self.assertFalse(
            holes.block_has_evidence({"cocotb": {"missing_required_classes": ["x"], "bins_hit": 2}})
        )


class FpgaSimAlignmentTests(unittest.TestCase):
    def test_parse_kv_manifest(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as raw:
            path = Path(raw) / "m.manifest"
            path.write_text("status=PASS\nfirmware_sha256=abc123\n", encoding="utf-8")
            self.assertEqual(
                align.parse_kv_manifest(path),
                {"status": "PASS", "firmware_sha256": "abc123"},
            )

    def test_alignment_report_declares_false_claim_flags(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as raw:
            out = Path(raw) / "fpga-sim.json"
            align.main(["--out", str(out)])
            report = json.loads(out.read_text(encoding="utf-8"))
        for key in align.FALSE_CLAIM_FLAGS:
            self.assertIs(report.get(key), False, key)


class SecurityRtlClaimBoundaryTests(unittest.TestCase):
    def test_mcie_report_declares_false_claim_flags_when_blocked(self) -> None:
        import tempfile
        from unittest import mock

        with tempfile.TemporaryDirectory(dir=mcie.ROOT / "build") as raw:
            report_path = Path(raw) / "mcie.json"
            with mock.patch.object(mcie, "REPORT", report_path), mock.patch.object(
                mcie, "_verilator", return_value=None
            ):
                rc = mcie.main()
            report = json.loads(report_path.read_text(encoding="utf-8"))

        self.assertEqual(rc, 2)
        for key in mcie.FALSE_CLAIM_FLAGS:
            self.assertIs(report.get(key), False, key)

    def test_iopmp_report_declares_false_claim_flags_when_blocked(self) -> None:
        import tempfile
        from unittest import mock

        with tempfile.TemporaryDirectory(dir=iopmp.ROOT / "build") as raw:
            report_path = Path(raw) / "iopmp.json"
            with mock.patch.object(iopmp, "REPORT", report_path), mock.patch.object(
                iopmp, "_verilator", return_value=None
            ):
                rc = iopmp.main()
            report = json.loads(report_path.read_text(encoding="utf-8"))

        self.assertEqual(rc, 2)
        for key in iopmp.FALSE_CLAIM_FLAGS:
            self.assertIs(report.get(key), False, key)

    def test_interrupt_controller_report_declares_false_claim_flags_when_blocked(self) -> None:
        import tempfile
        from unittest import mock

        with tempfile.TemporaryDirectory(dir=intc.ROOT / "build") as raw:
            report_path = Path(raw) / "interrupt-controller.json"
            with mock.patch.object(intc, "REPORT", report_path), mock.patch.object(
                intc, "_verilator", return_value=None
            ):
                rc = intc.main()
            report = json.loads(report_path.read_text(encoding="utf-8"))

        self.assertEqual(rc, 2)
        for key in intc.FALSE_CLAIM_FLAGS:
            self.assertIs(report.get(key), False, key)


class WaveformPolicyTests(unittest.TestCase):
    def test_default_run_passes_blocked_empty(self) -> None:
        # The shipped policy + blocked-empty provenance ledger must pass without
        # --provenance and fail closed with --provenance (no captures yet).
        self.assertEqual(wave.main([]), 0)
        self.assertEqual(wave.main(["--provenance"]), 1)

    def test_waveform_policy_false_claim_flags_are_declared(self) -> None:
        policy = wave.load_yaml_object(wave.POLICY)
        for key in wave.REQUIRED_FALSE_CLAIM_FLAGS:
            self.assertIs(policy.get(key), False, key)


class BspPolicyTests(unittest.TestCase):
    def test_shipped_policy_passes(self) -> None:
        self.assertEqual(bsp.main(), 0)


if __name__ == "__main__":
    unittest.main()
