from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_full_payload_repair_mapping_maps_every_payload_shard() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_full_payload_repair_mapping.py"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert result.returncode == 0, result.stdout
    assert "PASS: E1X full-payload repair mapping" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_full_payload_repair_mapping.json").read_text())
    summary = report["summary"]

    assert report["status"] == "PASS"
    assert summary["failing_check_count"] == 0
    assert summary["payload_shard_record_count"] == 151_367
    assert summary["payload_loader_word_count"] == 1_627_034_880
    assert summary["payload_stream_bytes"] == 6_508_139_520
    assert summary["payload_manifest_checksum"] == 15_384_439_414_980_776_514
    assert summary["normal_payload_remapped_records"] == 279
    assert summary["high_failure_payload_remapped_records"] == 3_012
    assert summary["normal_payload_direct_records"] == 151_088
    assert summary["high_failure_payload_direct_records"] == 148_355
    assert summary["high_vs_normal_payload_remap_ratio"] > 10.0
    assert summary["normal_payload_mapping_checksum"] == 10_456_726_157_466_213_831
    assert summary["high_failure_payload_mapping_checksum"] == 10_771_944_608_718_332_026
    assert summary["normal_route_checksum"] == 3_286_450_877_122_388_120
    assert summary["high_failure_route_checksum"] == 8_141_847_437_961_269_241
    assert summary["combined_payload_repair_checksum"] == 3_128_472_446_271_365_767
    assert (
        summary["case_summary_sha256"]
        == "41adf4631147bc4644543caa155e21e031cb721b39a7bd630fbf6e9a929c40ec"
    )
    assert summary["residual_blocker"] == "full_quantized_weight_payload_executor_missing"
