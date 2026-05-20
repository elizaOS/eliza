#!/usr/bin/env python3
"""Tests for scripts/check_phone_runtime_readiness_contract.py."""

from __future__ import annotations

import sys
import unittest
from argparse import Namespace
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import check_phone_runtime_readiness_contract as gate  # noqa: E402


def report(name: str, *, status: str, allowed: bool) -> dict:
    return {
        "schema": f"eliza.{name}.v1",
        "status": status,
        "claim_boundary": "fixture",
        "summary": {"release_claim_allowed": allowed},
    }


def spec(name: str, status: str = "ready") -> gate.ScopeSpec:
    return gate.ScopeSpec(
        name=name,
        report_builder=lambda: report(name, status=status, allowed=status == "ready"),
        validator=lambda _report: [],
        required_status="ready",
        runtime_surface=f"{name} surface",
        required_runtime_evidence=("runtime proof",),
    )


class PhoneRuntimeReadinessContractTests(unittest.TestCase):
    def test_current_release_blocked_scope_reports_block_objective(self) -> None:
        blocked = gate.ScopeSpec(
            name="media",
            report_builder=lambda: report(
                "media", status="phone_media_pipeline_scope_release_blocked", allowed=False
            ),
            validator=lambda _report: [],
            required_status="phone_media_pipeline_runtime_ready",
            runtime_surface="display/camera",
            required_runtime_evidence=("HWC proof", "Camera HAL proof"),
        )
        with mock.patch.object(gate, "SCOPES", (blocked,)):
            payload = gate.run_check(Namespace())
        self.assertEqual(payload["status"], "blocked")
        self.assertEqual(payload["summary"]["blockers"], 1)
        self.assertEqual(payload["findings"][0]["code"], "media_runtime_surface_blocked")

    def test_all_runtime_ready_scope_reports_pass(self) -> None:
        with mock.patch.object(gate, "SCOPES", (spec("media"), spec("security"))):
            payload = gate.run_check(Namespace())
        self.assertEqual(payload["status"], "pass")
        self.assertEqual(payload["findings"], [])

    def test_invalid_scope_report_is_failure(self) -> None:
        invalid = gate.ScopeSpec(
            name="radio",
            report_builder=lambda: report("radio", status="ready", allowed=True),
            validator=lambda _report: ["bad schema"],
            required_status="ready",
            runtime_surface="radio",
            required_runtime_evidence=("radio proof",),
        )
        with mock.patch.object(gate, "SCOPES", (invalid,)):
            payload = gate.run_check(Namespace())
        self.assertEqual(payload["status"], "fail")
        self.assertEqual(payload["summary"]["failures"], 1)
        self.assertEqual(payload["findings"][0]["code"], "radio_scope_report_invalid")


if __name__ == "__main__":
    unittest.main()
