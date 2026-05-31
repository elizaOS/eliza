from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_full_payload_manifest_commits_every_shard_record() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_full_payload_manifest.py"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert result.returncode == 0, result.stdout
    assert "PASS: E1X full payload manifest" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_full_payload_manifest.json").read_text())
    summary = report["summary"]

    assert report["status"] == "PASS"
    assert summary["failing_check_count"] == 0
    assert summary["committed_layer_count"] == 283
    assert summary["committed_shard_record_count"] == 151_367
    assert summary["committed_logical_core_count"] == 151_367
    assert summary["committed_loader_word_count"] == 1_627_034_880
    assert summary["committed_stream_bytes"] == 6_508_139_520
    assert summary["committed_probe_word_count"] == 454_101
    assert summary["probe_word_fraction_of_loader_stream"] == 0.00027909727417767467
    assert summary["max_loader_words_per_shard"] == 10_880
    assert summary["payload_manifest_checksum"] == 15_384_439_414_980_776_514
    assert (
        summary["layer_commitment_sha256"]
        == "be765abe713d8def565e0b95518738c2666c1b5a2707d5b11dd53ac64e5f9763"
    )
    assert (
        summary["sampled_record_sha256"]
        == "77d20cb872cd4906fc1ff344c77fb0f40d1c9397fbb9142f9daf2d00e7a52dd7"
    )
    assert summary["residual_blocker"] == "full_quantized_weight_payload_executor_missing"
