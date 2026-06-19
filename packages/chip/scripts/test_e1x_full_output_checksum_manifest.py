from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_full_output_checksum_manifest_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_full_output_checksum_manifest.py"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
    )
    report = json.loads((ROOT / "build/reports/e1x_full_output_checksum_manifest.json").read_text())
    assert result.returncode == 0, result.stdout
    assert "PASS: E1X full-output checksum manifest" in result.stdout
    assert report["status"] == "PASS"
    assert report["summary"]["failing_check_count"] == 0
    assert report["summary"]["committed_layer_count"] == 283
    assert report["summary"]["committed_output_row_count"] == 2_608_640
    assert report["summary"]["committed_mac_count"] == 13_015_864_320
    assert report["summary"]["committed_vector_word_op_count"] == 1_627_345_920
    assert report["summary"]["committed_row_probe_count"] == 849
    assert report["summary"]["row_identity_manifest_checksum"] == 5_613_227_195_448_189_553
    assert (
        report["summary"]["layer_commitment_sha256"]
        == "58e4218553aae175a065025d4faa702f7da4e7721a798d88d6e5e7852ec154b5"
    )
    assert report["summary"]["sampled_output_checksum"] == 14_414_877_542_268_347_137
    assert report["summary"]["routed_window_checksum"] == 4_718_384_912_712_357_942
    assert report["summary"]["normal_trace_output_checksum"] == 8_263_636_289_739_888_019
    assert report["summary"]["high_failure_trace_output_checksum"] == 3_419_781_716_949_080_192
    assert report["summary"]["missing_output_row_count"] == 2_607_508
    assert report["summary"]["missing_mac_count"] == 13_015_838_140
    assert report["summary"]["residual_blocker"] == "full_output_real_weight_checksum_missing"
    assert report["full_output_execution_claim_allowed"] is False
    assert report["real_model_full_output_claim_allowed"] is False
