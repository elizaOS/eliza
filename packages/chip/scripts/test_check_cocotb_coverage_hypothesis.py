#!/usr/bin/env python3
"""Hypothesis-based property tests for ``scripts/check_cocotb_coverage.py``.

These tests fuzz the structure of the per-block coverage JSON consumed by
the merge step. The invariants are:

- Any coverage payload missing the canonical ``schema`` field is rejected
  with a non-zero exit.
- Any block JSON whose declared classes form a superset of the required
  set passes the merge with status ``passed``.
- Any block JSON whose declared classes drop a required class fails the
  merge with status ``failed`` and a structured error.

The tests skip cleanly when Hypothesis is not installed.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECK_PATH = ROOT / "scripts/check_cocotb_coverage.py"

spec = importlib.util.spec_from_file_location("check_cocotb_coverage", CHECK_PATH)
if spec is None or spec.loader is None:  # pragma: no cover - defensive
    raise RuntimeError(f"could not import {CHECK_PATH}")
check_module = importlib.util.module_from_spec(spec)
sys.modules["check_cocotb_coverage"] = check_module
spec.loader.exec_module(check_module)

try:
    from hypothesis import HealthCheck, given, settings
    from hypothesis import strategies as st

    HYPOTHESIS_AVAILABLE = True
except ImportError:  # pragma: no cover - skip when hypothesis is absent
    HYPOTHESIS_AVAILABLE = False
    raise unittest.SkipTest("hypothesis is not installed") from None


def _make_block_payload(
    block: str,
    classes: list[str],
    *,
    schema: str = "eliza.cocotb_coverage.v1",
) -> dict[str, object]:
    classes_payload: dict[str, dict[str, dict[str, object]]] = {}
    for class_name in classes:
        classes_payload[class_name] = {
            f"{class_name}_point": {
                "declared_bins": ["a", "b"],
                "bins": {"a": 1, "b": 2},
                "hits": 3,
                "unique_bins": 2,
            }
        }
    return {
        "schema": schema,
        "block": block,
        "cocotb_coverage_available": False,
        "classes": classes_payload,
    }


def _write(payload: dict[str, object], path: Path) -> None:
    path.write_text(json.dumps(payload), encoding="utf-8")


@unittest.skipUnless(HYPOTHESIS_AVAILABLE, "hypothesis is not installed")
class CoverageMergeHypothesisTests(unittest.TestCase):
    @settings(
        max_examples=40,
        deadline=None,
        suppress_health_check=[HealthCheck.too_slow],
    )
    @given(
        block=st.sampled_from(sorted(check_module.REQUIRED_CLASSES)),
        extras=st.lists(
            st.text(
                st.characters(exclude_categories=["Cs"]),
                min_size=1,
                max_size=16,
            ),
            min_size=0,
            max_size=4,
            unique=True,
        ),
    )
    def test_passes_when_required_classes_present(self, block: str, extras: list[str]) -> None:
        required = sorted(check_module.REQUIRED_CLASSES[block])
        classes = required + [extra for extra in extras if extra not in required]
        with tempfile.TemporaryDirectory() as workdir:
            work = Path(workdir)
            _write(_make_block_payload(block, classes), work / f"{block}.json")
            rc = check_module.main(["--coverage-dir", str(work)])
        self.assertEqual(rc, 0)

    @settings(
        max_examples=20,
        deadline=None,
        suppress_health_check=[HealthCheck.too_slow],
    )
    @given(
        block=st.sampled_from(sorted(check_module.REQUIRED_CLASSES)),
    )
    def test_fails_when_required_class_missing(self, block: str) -> None:
        required = sorted(check_module.REQUIRED_CLASSES[block])
        if not required:
            return
        dropped = required[0]
        remaining = [cls for cls in required if cls != dropped]
        with tempfile.TemporaryDirectory() as workdir:
            work = Path(workdir)
            _write(_make_block_payload(block, remaining), work / f"{block}.json")
            rc = check_module.main(["--coverage-dir", str(work)])
        self.assertEqual(rc, 1)

    @settings(
        max_examples=20,
        deadline=None,
    )
    @given(
        block=st.sampled_from(sorted(check_module.REQUIRED_CLASSES)),
        bogus_schema=st.text(
            st.characters(exclude_categories=["Cs"]),
            min_size=1,
            max_size=40,
        ),
    )
    def test_rejects_wrong_schema(self, block: str, bogus_schema: str) -> None:
        if bogus_schema == "eliza.cocotb_coverage.v1":
            return
        required = sorted(check_module.REQUIRED_CLASSES[block])
        payload = _make_block_payload(block, required, schema=bogus_schema)
        with tempfile.TemporaryDirectory() as workdir:
            work = Path(workdir)
            _write(payload, work / f"{block}.json")
            with self.assertRaises(SystemExit):
                check_module.main(["--coverage-dir", str(work)])


if __name__ == "__main__":
    unittest.main()
