"""Unit tests for benchmarks/parsers/*."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from benchmarks.parsers import (  # noqa: E402
    ParseError,  # noqa: E402
    parse_coremark,
    parse_fio,
    parse_lmbench,
    parse_stream,
    parse_tflite,
)

FIX = Path(__file__).parent / "fixtures"


def _read(name: str) -> str:
    return (FIX / name).read_text(encoding="utf-8")


class CoreMarkTests(unittest.TestCase):
    def test_parses_required_metrics(self) -> None:
        m = parse_coremark.parse(_read("coremark.txt"))
        self.assertAlmostEqual(m["iterations_per_second"], 8100.50)
        self.assertAlmostEqual(m["coremark_per_mhz"], 4.05)
        self.assertEqual(m["iterations"], 100000)
        self.assertAlmostEqual(m["total_time_sec"], 12.345)

    def test_rejects_missing_iter_sec(self) -> None:
        with self.assertRaises(ParseError):
            parse_coremark.parse("nothing useful here\n")


class StreamTests(unittest.TestCase):
    def test_parses_all_four_kernels(self) -> None:
        m = parse_stream.parse(_read("stream.txt"))
        self.assertAlmostEqual(m["triad_mb_per_s"], 10750.3)
        self.assertAlmostEqual(m["copy_mb_per_s"], 12345.6)
        self.assertAlmostEqual(m["scale_mb_per_s"], 11000.1)
        self.assertAlmostEqual(m["add_mb_per_s"], 10800.2)

    def test_rejects_missing_triad(self) -> None:
        with self.assertRaises(ParseError):
            parse_stream.parse("Copy: 1000 0 0 0\n")


class LmbenchTests(unittest.TestCase):
    def test_bw_mem(self) -> None:
        m = parse_lmbench.parse_bw_mem(_read("bw_mem.txt"))
        self.assertAlmostEqual(m["bandwidth_mb_per_s"], 2453.55)
        self.assertAlmostEqual(m["size_mb"], 67.11)

    def test_lat_mem_rd(self) -> None:
        m = parse_lmbench.parse_lat_mem_rd(_read("lat_mem_rd.txt"))
        self.assertEqual(m["stride"], 128)
        self.assertGreater(len(m["points"]), 5)
        self.assertAlmostEqual(m["max_latency_ns"], 110.000)
        self.assertAlmostEqual(m["min_latency_ns"], 1.234)

    def test_auto_dispatch(self) -> None:
        bw = parse_lmbench.parse(_read("bw_mem.txt"))
        self.assertIn("bandwidth_mb_per_s", bw)
        lat = parse_lmbench.parse(_read("lat_mem_rd.txt"))
        self.assertIn("points", lat)

    def test_rejects_empty(self) -> None:
        with self.assertRaises(ParseError):
            parse_lmbench.parse_bw_mem("\n\n")
        with self.assertRaises(ParseError):
            parse_lmbench.parse_lat_mem_rd("stride=128\nno numbers here\n")


class FioTests(unittest.TestCase):
    def test_aggregates_jobs(self) -> None:
        m = parse_fio.parse(_read("fio.json"))
        self.assertAlmostEqual(m["read_iops"], 12345.6 + 5000.0)
        self.assertAlmostEqual(m["write_iops"], 4500.0)
        self.assertAlmostEqual(m["read_bw_kib_s"], 49382.0 + 20000.0)
        self.assertAlmostEqual(m["write_bw_kib_s"], 18000.0)
        self.assertEqual(len(m["jobs"]), 2)

    def test_rejects_non_json(self) -> None:
        with self.assertRaises(ParseError):
            parse_fio.parse("this is not json\n")

    def test_rejects_zero_jobs(self) -> None:
        with self.assertRaises(ParseError):
            parse_fio.parse('{"fio version":"x","jobs":[]}')

    def test_rejects_all_zero(self) -> None:
        with self.assertRaises(ParseError):
            parse_fio.parse(
                '{"jobs":[{"jobname":"x","read":{"iops":0,"bw":0},"write":{"iops":0,"bw":0}}]}'
            )


class TFLiteTests(unittest.TestCase):
    def test_cpu_run(self) -> None:
        m = parse_tflite.parse(_read("tflite_cpu.txt"))
        self.assertAlmostEqual(m["avg_latency_us"], 875.4)
        self.assertAlmostEqual(m["init_us"], 876)
        self.assertAlmostEqual(m["first_inference_us"], 2510)
        self.assertNotIn("cpu_fallback_percent", m)

    def test_nnapi_run(self) -> None:
        m = parse_tflite.parse(_read("tflite_nnapi.txt"))
        self.assertAlmostEqual(m["avg_latency_us"], 635.7)
        self.assertEqual(m["nnapi_delegated_nodes"], 7)
        self.assertEqual(m["cpu_fallback_nodes"], 3)
        self.assertEqual(m["unsupported_op_count"], 3)
        self.assertAlmostEqual(m["cpu_fallback_percent"], 30.0)

    def test_rejects_missing_timing_line(self) -> None:
        with self.assertRaises(ParseError):
            parse_tflite.parse("STARTING!\nno timings here\n")


if __name__ == "__main__":
    unittest.main()
