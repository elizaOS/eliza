#!/usr/bin/env python3
"""Tests for scripts/check_mvp_status.py."""

from __future__ import annotations

import contextlib
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import check_mvp_status as mvp


class ProductStatusTests(unittest.TestCase):
    def test_product_status_uses_existing_release_report_without_rerun(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            report = root / "build/reports/product_release_status.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                (
                    '{"schema":"eliza.product_release_status.v1",'
                    '"status":"blocked","release_blockers":[{"code":"x"}],'
                    '"next_step":"close blockers"}'
                ),
                encoding="utf-8",
            )

            with (
                mock.patch("check_mvp_status.ROOT", root),
                mock.patch("check_mvp_status.subprocess.run") as run,
            ):
                status = mvp.product_status()

        run.assert_not_called()
        self.assertEqual(status.status, mvp.BLOCK)
        self.assertEqual(status.evidence_class, "release_blocker")
        self.assertIn("1 product release blockers", status.evidence)

    def test_product_status_timeout_is_block_not_hang(self) -> None:
        with (
            tempfile.TemporaryDirectory() as tmpdir,
            mock.patch("check_mvp_status.ROOT", Path(tmpdir)),
            mock.patch(
                "check_mvp_status.subprocess.run",
                side_effect=subprocess.TimeoutExpired(["python3", "scripts/product_check.py"], 1),
            ),
        ):
            status = mvp.product_status()

        self.assertEqual(status.subsystem, "product-package")
        self.assertEqual(status.status, mvp.BLOCK)
        self.assertEqual(status.evidence_class, "release_blocker")
        self.assertIn("status timeout", status.evidence)

    def test_json_status_rows_keep_claims_false(self) -> None:
        rows = [mvp.Status("demo", mvp.PASS, "ok", "none", "command_pass")]
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            mvp.print_json(rows)
        payload = json.loads(output.getvalue())
        self.assertEqual(payload[0]["subsystem"], "demo")
        for claim_key in mvp.FALSE_CLAIM_FLAGS:
            self.assertIs(payload[0][claim_key], False, claim_key)


if __name__ == "__main__":
    unittest.main()
