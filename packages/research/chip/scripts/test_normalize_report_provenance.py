#!/usr/bin/env python3
"""Regression tests for generated report provenance normalization."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import normalize_report_provenance as normalizer


class NormalizeReportProvenanceTests(unittest.TestCase):
    def test_preserves_structured_claim_boundary(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            path = Path(raw_tmp) / "report.yaml"
            path.write_text("status: blocked\n", encoding="utf-8")
            payload = {
                "claim_boundary": {
                    "allowed_current_claims": ["scaffold only"],
                    "blocked_claims": ["release evidence"],
                },
                "generated_utc": "2026-05-20T10:12:30Z",
            }

            normalized, changed = normalizer.normalize_payload(path, payload)

        self.assertFalse(changed)
        self.assertEqual(normalized["claim_boundary"], payload["claim_boundary"])

    def test_replaces_missing_claim_boundary(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            path = Path(raw_tmp) / "report.yaml"
            path.write_text("status: blocked\n", encoding="utf-8")
            normalized, changed = normalizer.normalize_payload(
                path,
                {"generated_utc": "2026-05-20T10:12:30Z"},
            )

        self.assertTrue(changed)
        self.assertEqual(
            normalized["claim_boundary"],
            normalizer.DEFAULT_CLAIM_BOUNDARY,
        )


if __name__ == "__main__":
    unittest.main()
