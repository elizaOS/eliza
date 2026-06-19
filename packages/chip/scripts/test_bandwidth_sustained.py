#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECKER = ROOT / "scripts/check_bandwidth_sustained.py"


def run_checker(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["python3", str(CHECKER), *args],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def write_inputs(root: Path, *, peak: float, sustained: float, latency: float) -> dict[str, Path]:
    stream = root / "stream.json"
    rd = root / "bw_rd.txt"
    wr = root / "bw_wr.txt"
    lat = root / "lat.txt"
    stream.write_text(
        json.dumps({"kernels": [{"name": "triad", "best_gbps": peak, "avg_gbps": sustained}]}),
        encoding="utf-8",
    )
    rd.write_text("1024.00 90000.00\n", encoding="utf-8")
    wr.write_text("1024.00 91000.00\n", encoding="utf-8")
    lat.write_text(f"1024 {latency}\n2048 {latency}\n", encoding="utf-8")
    return {"stream": stream, "rd": rd, "wr": wr, "lat": lat}


def test_complete_but_below_threshold_inputs_block() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        inputs = write_inputs(root, peak=1.0, sustained=1.0, latency=1000.0)
        out = root / "report.json"
        result = run_checker(
            [
                "--target-id",
                "phone-baseline",
                "--stream-json",
                str(inputs["stream"]),
                "--lmbench-rd-raw",
                str(inputs["rd"]),
                "--lmbench-wr-raw",
                str(inputs["wr"]),
                "--lmbench-lat-raw",
                str(inputs["lat"]),
                "--output",
                str(out),
            ]
        )
        if result.returncode != 2:
            raise AssertionError(result.stdout)
        report = json.loads(out.read_text(encoding="utf-8"))
        pass_fail = report.get("pass_fail_against_phone_2028_target_profile")
        if not isinstance(pass_fail, dict) or pass_fail.get("overall") != "fail":
            raise AssertionError(report)
        if report.get("target_thresholds_status") != "fail":
            raise AssertionError(report)
        if not report.get("threshold_failures"):
            raise AssertionError(report)
    print("PASS complete below-threshold bandwidth inputs block")


def test_complete_inputs_meeting_sku_thresholds_pass() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        inputs = write_inputs(root, peak=172.8, sustained=140.0, latency=100.0)
        out = root / "report.json"
        result = run_checker(
            [
                "--target-id",
                "phone-ai",
                "--stream-json",
                str(inputs["stream"]),
                "--lmbench-rd-raw",
                str(inputs["rd"]),
                "--lmbench-wr-raw",
                str(inputs["wr"]),
                "--lmbench-lat-raw",
                str(inputs["lat"]),
                "--output",
                str(out),
            ]
        )
        if result.returncode != 0:
            raise AssertionError(result.stdout)
        report = json.loads(out.read_text(encoding="utf-8"))
        if report.get("schema") != "eliza.memory.bandwidth_latency_threshold_parser.v1":
            raise AssertionError(report)
        if report.get("evidence_class") != "threshold_parser_output":
            raise AssertionError(report)
        pass_fail = report.get("pass_fail_against_phone_2028_target_profile")
        if not isinstance(pass_fail, dict) or pass_fail.get("overall") != "downgraded":
            raise AssertionError(report)
        if pass_fail.get("peak_bandwidth_gbps_min_180") != "downgraded":
            raise AssertionError(report)
        if not report.get("target_downgrades"):
            raise AssertionError(report)
        if pass_fail.get("contended_trace_present") != "downgraded":
            raise AssertionError(report)
        if report.get("target_thresholds_status") != "downgraded":
            raise AssertionError(report)
        if report.get("release_claim_allowed") is not False:
            raise AssertionError(report)
        metrics = report.get("parsed_metrics")
        if metrics.get("lmbench_rd_mb_per_s") != 90000.0:
            raise AssertionError(report)
        if metrics.get("lmbench_wr_mb_per_s") != 91000.0:
            raise AssertionError(report)
    print("PASS complete bandwidth inputs meeting AI SKU thresholds downgrade peak gate")


def test_ai_sku_sustained_target_is_enforced() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        inputs = write_inputs(root, peak=172.8, sustained=125.0, latency=100.0)
        out = root / "report.json"
        result = run_checker(
            [
                "--target-id",
                "phone-ai",
                "--stream-json",
                str(inputs["stream"]),
                "--lmbench-rd-raw",
                str(inputs["rd"]),
                "--lmbench-wr-raw",
                str(inputs["wr"]),
                "--lmbench-lat-raw",
                str(inputs["lat"]),
                "--output",
                str(out),
            ]
        )
        if result.returncode != 2:
            raise AssertionError(result.stdout)
        report = json.loads(out.read_text(encoding="utf-8"))
        if report.get("target_thresholds_status") != "fail":
            raise AssertionError(report)
        if "sustained_bandwidth_gbps" not in result.stdout:
            raise AssertionError(result.stdout)
    print("PASS phone-ai sustained SKU target is enforced")


def test_non_numeric_stream_metrics_block_cleanly() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        inputs = write_inputs(root, peak=90.0, sustained=75.0, latency=100.0)
        inputs["stream"].write_text(
            json.dumps({"kernels": [{"name": "triad", "best_gbps": "fast", "avg_gbps": 75.0}]}),
            encoding="utf-8",
        )
        out = root / "report.json"
        result = run_checker(
            [
                "--target-id",
                "phone-baseline",
                "--stream-json",
                str(inputs["stream"]),
                "--lmbench-rd-raw",
                str(inputs["rd"]),
                "--lmbench-wr-raw",
                str(inputs["wr"]),
                "--lmbench-lat-raw",
                str(inputs["lat"]),
                "--output",
                str(out),
            ]
        )
        if result.returncode != 2:
            raise AssertionError(result.stdout)
        if "peak_bandwidth_gbps" not in result.stdout:
            raise AssertionError(result.stdout)
    print("PASS non-numeric bandwidth metrics block cleanly")


def test_unknown_target_id_rejected() -> None:
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "report.json"
        result = run_checker(["--target-id", "phone-pro", "--output", str(out)])
        if result.returncode != 1:
            raise AssertionError(result.stdout)
    print("PASS unknown bandwidth target id rejected")


def main() -> None:
    test_complete_but_below_threshold_inputs_block()
    test_complete_inputs_meeting_sku_thresholds_pass()
    test_ai_sku_sustained_target_is_enforced()
    test_non_numeric_stream_metrics_block_cleanly()
    test_unknown_target_id_rejected()


if __name__ == "__main__":
    main()
