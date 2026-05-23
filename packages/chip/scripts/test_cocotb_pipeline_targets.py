#!/usr/bin/env python3
"""Keep cocotb pipeline target generation and validation aligned."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

from check_cocotb_results import PIPELINE_TARGETS
from pipeline_check import COCOTB_TARGETS

ROOT = Path(__file__).resolve().parents[1]


def evidence_regression_deps() -> set[str]:
    makefile = (ROOT / "Makefile").read_text()
    match = re.search(r"^evidence-regression-test:\s*(.+)$", makefile, re.MULTILINE)
    if match is None:
        raise AssertionError("evidence-regression-test target missing")
    return set(match.group(1).split())


class CocotbPipelineTargetsTest(unittest.TestCase):
    def test_manifest_writer_and_pipeline_check_target_sets_match(self) -> None:
        self.assertEqual(PIPELINE_TARGETS, COCOTB_TARGETS)

    def test_release_regression_generates_required_cocotb_targets(self) -> None:
        deps = evidence_regression_deps()
        self.assertIn("cocotb", deps)
        self.assertIn("cocotb-npu", deps)
        self.assertIn("cocotb-contract", deps)
        self.assertIn("cocotb-cpu", deps)
        self.assertIn("cocotb-cross-domain", deps)

    def test_release_regression_generates_pipeline_artifacts(self) -> None:
        deps = evidence_regression_deps()
        self.assertIn("synth", deps)
        self.assertIn("verilator", deps)
        self.assertIn("formal", deps)
        self.assertIn("record-tool-versions", deps)
        self.assertIn("strict-release-gate-test", deps)


if __name__ == "__main__":
    unittest.main()
