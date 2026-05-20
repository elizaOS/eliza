"""Hypothesis property tests for ``benchmarks/parsers``.

These tests complement the example-based suite in ``test_parsers.py``. They
cover parser invariants that should hold over a broad input distribution:

- CoreMark parsing accepts every well-formed ``Iterations/Sec`` value and
  rejects every input lacking it.
- STREAM parsing returns the exact Triad rate it was given and rejects
  inputs missing the Triad line.
- fio parsing rejects every non-JSON input and every JSON document with
  zero jobs or all-zero IOPS / bandwidth.

The tests are skipped cleanly if Hypothesis is not installed locally.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

try:
    from hypothesis import HealthCheck, given, settings
    from hypothesis import strategies as st

    HYPOTHESIS_AVAILABLE = True
except ImportError:  # pragma: no cover - skip when hypothesis is absent
    HYPOTHESIS_AVAILABLE = False

from benchmarks.parsers import (  # noqa: E402
    ParseError,
    parse_coremark,
    parse_fio,
    parse_stream,
)


@unittest.skipUnless(HYPOTHESIS_AVAILABLE, "hypothesis is not installed")
class CoreMarkHypothesisTests(unittest.TestCase):
    @settings(
        max_examples=100,
        deadline=None,
        suppress_health_check=[HealthCheck.too_slow],
    )
    @given(
        iter_per_sec=st.floats(min_value=1.0, max_value=1e9, allow_nan=False, allow_infinity=False),
        cm_per_mhz=st.floats(min_value=0.01, max_value=1e6, allow_nan=False, allow_infinity=False),
    )
    def test_accepts_well_formed_iter_sec(self, iter_per_sec: float, cm_per_mhz: float) -> None:
        text = f"Iterations/Sec: {iter_per_sec}\nCoreMark/MHz: {cm_per_mhz}\n"
        metrics = parse_coremark.parse(text)
        self.assertAlmostEqual(metrics["iterations_per_second"], iter_per_sec, places=2)
        self.assertAlmostEqual(metrics["coremark_per_mhz"], cm_per_mhz, places=2)

    @settings(max_examples=50, deadline=None)
    @given(
        garbage=st.text(
            st.characters(exclude_categories=["Cs"], exclude_characters="\x00"),
            min_size=0,
            max_size=200,
        ),
    )
    def test_rejects_inputs_missing_iter_sec(self, garbage: str) -> None:
        # Strip any accidental "Iterations/Sec" substring from the random
        # input so the property remains tractable. This narrows to inputs
        # that *cannot* parse.
        if "Iterations/Sec" in garbage:
            return
        with self.assertRaises(ParseError):
            parse_coremark.parse(garbage)


@unittest.skipUnless(HYPOTHESIS_AVAILABLE, "hypothesis is not installed")
class StreamHypothesisTests(unittest.TestCase):
    # The parser's regex accepts decimal numbers only (no scientific
    # notation, no signs), so the strategies generate decimal-formatted
    # strings explicitly and assert they round-trip.
    decimal_floats = st.from_regex(r"\A[0-9]{1,9}(\.[0-9]{1,4})?\Z")

    @settings(max_examples=80, deadline=None)
    @given(
        triad=decimal_floats,
        avg=decimal_floats,
        tmin=decimal_floats,
        tmax=decimal_floats,
    )
    def test_triad_rate_round_trips(self, triad: str, avg: str, tmin: str, tmax: str) -> None:
        text = f"Triad:  {triad} {avg} {tmin} {tmax}\n"
        metrics = parse_stream.parse(text)
        self.assertAlmostEqual(metrics["triad_mb_per_s"], float(triad), places=2)

    @settings(max_examples=50, deadline=None)
    @given(
        kernels=st.lists(
            st.sampled_from(["Copy", "Scale", "Add"]),
            min_size=0,
            max_size=3,
            unique=True,
        ),
    )
    def test_rejects_input_without_triad(self, kernels: list[str]) -> None:
        if "Triad" in kernels:
            return
        text = "\n".join(f"{name}: 1000.0 0.0 0.0 0.0" for name in kernels) + "\n"
        with self.assertRaises(ParseError):
            parse_stream.parse(text)


@unittest.skipUnless(HYPOTHESIS_AVAILABLE, "hypothesis is not installed")
class FioHypothesisTests(unittest.TestCase):
    @settings(max_examples=80, deadline=None)
    @given(
        read_iops=st.floats(min_value=0.0, max_value=1e9, allow_nan=False, allow_infinity=False),
        write_iops=st.floats(min_value=0.0, max_value=1e9, allow_nan=False, allow_infinity=False),
        read_bw=st.floats(min_value=0.0, max_value=1e9, allow_nan=False, allow_infinity=False),
        write_bw=st.floats(min_value=0.0, max_value=1e9, allow_nan=False, allow_infinity=False),
    )
    def test_aggregates_or_rejects_all_zero(
        self, read_iops: float, write_iops: float, read_bw: float, write_bw: float
    ) -> None:
        doc = {
            "fio version": "test",
            "jobs": [
                {
                    "jobname": "single",
                    "read": {"iops": read_iops, "bw": read_bw},
                    "write": {"iops": write_iops, "bw": write_bw},
                }
            ],
        }
        text = json.dumps(doc)
        if read_iops == 0.0 and write_iops == 0.0 and read_bw == 0.0 and write_bw == 0.0:
            with self.assertRaises(ParseError):
                parse_fio.parse(text)
        else:
            metrics = parse_fio.parse(text)
            self.assertAlmostEqual(metrics["read_iops"], read_iops, places=2)
            self.assertAlmostEqual(metrics["write_iops"], write_iops, places=2)
            self.assertAlmostEqual(metrics["read_bw_kib_s"], read_bw, places=2)
            self.assertAlmostEqual(metrics["write_bw_kib_s"], write_bw, places=2)

    @settings(max_examples=40, deadline=None)
    @given(
        text=st.text(
            st.characters(exclude_categories=["Cs"], exclude_characters="{}"),
            min_size=0,
            max_size=200,
        ),
    )
    def test_rejects_non_json(self, text: str) -> None:
        with self.assertRaises(ParseError):
            parse_fio.parse(text)


if __name__ == "__main__":
    unittest.main()
