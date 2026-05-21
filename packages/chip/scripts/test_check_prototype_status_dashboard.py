#!/usr/bin/env python3
"""Regression tests for prototype status dashboard validation."""

from __future__ import annotations

import unittest

from check_prototype_status_dashboard import conservative_snapshot_allowed


class PrototypeStatusDashboardTest(unittest.TestCase):
    def test_allows_conservative_generated_artifact_rows(self) -> None:
        status = {
            "status": "pass",
            "evidence_class": "generated_artifact",
            "next_step": "none",
        }
        row = {
            "Status": "`BLOCK`",
            "Evidence class": "`regen_required`",
            "Next action": "`make cocotb`",
        }
        self.assertTrue(conservative_snapshot_allowed("cocotb", status, row))

    def test_does_not_mask_nonvolatile_stale_rows(self) -> None:
        status = {
            "status": "pass",
            "evidence_class": "generated_artifact",
            "next_step": "none",
        }
        row = {
            "Status": "`BLOCK`",
            "Evidence class": "`regen_required`",
            "Next action": "`make qemu-check`",
        }
        self.assertFalse(conservative_snapshot_allowed("product-package", status, row))

    def test_allows_qemu_reference_smoke_to_remain_conservative(self) -> None:
        status = {
            "status": "pass",
            "evidence_class": "generated_artifact",
            "next_step": "none",
        }
        row = {
            "Status": "`BLOCK`",
            "Evidence class": "`tool_blocker`",
            "Next action": "`make qemu-check`",
        }
        self.assertTrue(conservative_snapshot_allowed("qemu", status, row))

    def test_allows_formal_fallback_to_remain_conservative(self) -> None:
        status = {
            "status": "block",
            "evidence_class": "formal_fallback",
            "next_step": "make formal-strict",
        }
        row = {
            "Status": "`BLOCK`",
            "Evidence class": "`tool_blocker`",
            "Next action": "`make formal inside Docker/Nix`",
        }
        self.assertTrue(conservative_snapshot_allowed("formal", status, row))

    def test_allows_tool_available_regen_drift(self) -> None:
        status = {
            "status": "block",
            "evidence_class": "regen_required",
            "next_step": "make synth",
        }
        row = {
            "Status": "`BLOCK`",
            "Evidence class": "`tool_blocker`",
            "Next action": "`make synth`",
        }
        self.assertTrue(conservative_snapshot_allowed("synthesis", status, row))


if __name__ == "__main__":
    unittest.main()
