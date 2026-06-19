from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_full_payload_repaired_run_links_payload_repair_and_traces() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_full_payload_repaired_run.py"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert result.returncode == 0, result.stdout
    assert "PASS: E1X full-payload repaired run" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_full_payload_repaired_run.json").read_text())
    summary = report["summary"]

    assert report["status"] == "PASS"
    assert summary["failing_check_count"] == 0
    assert summary["payload_shard_record_count"] == 151_367
    assert summary["payload_loader_word_count"] == 1_627_034_880
    assert summary["normal_payload_remap_words"] == 279
    assert summary["high_failure_payload_remap_words"] == 3_012
    assert summary["normal_total_cycles"] == 47_501_642_583
    assert summary["high_failure_total_cycles"] == 63_132_355_414
    assert summary["high_vs_normal_cycle_ratio"] > 1.3
    assert 0.7 < summary["high_vs_normal_decode_tps_ratio"] < 0.8
    assert summary["normal_output_checksum"] == 8_263_636_289_739_888_019
    assert summary["high_failure_output_checksum"] == 3_419_781_716_949_080_192
    assert summary["normal_route_checks"] == 4_096
    assert summary["high_failure_route_checks"] == 8_192
    assert summary["combined_repaired_run_checksum"] == 3_914_641_677_513_091_882
    assert (
        summary["normal_trace_sha256"]
        == "5fe31007632635c42efea77ca1f2ac2911d2584815ac74f5d2f7a6facf902af7"
    )
    assert (
        summary["high_failure_trace_sha256"]
        == "0df46c3be0753a814b1f99a72f82f3c19cd4e67b1cbffede00f9c757106d7eb3"
    )
    assert summary["residual_blocker"] == "full_output_real_weight_checksum_missing"
