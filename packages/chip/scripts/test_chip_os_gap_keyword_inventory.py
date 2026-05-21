#!/usr/bin/env python3
"""Tests for scripts/check_chip_os_gap_keyword_inventory.py."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import check_chip_os_gap_keyword_inventory as inv


class ChipOsGapKeywordInventoryTests(unittest.TestCase):
    def test_scans_source_markers_and_excludes_generated_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            source = repo / "packages/chip/sw/boot.sh"
            source.parent.mkdir(parents=True)
            source.write_text(
                "# TODO wire real boot\n"
                "raise NotImplementedError\n"
                "echo STATUS_LATER_AGENT_BINARY\n",
                encoding="utf-8",
            )
            generated = repo / "packages/app/android/app/src/main/assets/agent-bundle.js"
            generated.parent.mkdir(parents=True)
            generated.write_text("TODO generated bundle placeholder\n", encoding="utf-8")

            with mock.patch.object(inv, "REPO", repo):
                report = inv.build_report(["packages/chip/sw", "packages/app/android"])

        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["summary"]["findings"], 3)
        categories = report["summary"]["categories"]
        self.assertEqual(categories["todo"], 1)
        self.assertEqual(categories["implementation_missing"], 1)
        self.assertEqual(categories["deferred_blocked"], 1)
        paths = {finding["path"] for finding in report["findings"]}
        self.assertEqual(paths, {"packages/chip/sw/boot.sh"})

    def test_empty_scan_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            source = repo / "packages/chip/sw/boot.sh"
            source.parent.mkdir(parents=True)
            source.write_text("echo ready\n", encoding="utf-8")

            with mock.patch.object(inv, "REPO", repo):
                report = inv.build_report(["packages/chip/sw"])

        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["summary"]["findings"], 0)


if __name__ == "__main__":
    unittest.main()
