from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_full_payload_repair_rom_programs_all_payload_remaps() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_full_payload_repair_rom.py"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert result.returncode == 0, result.stdout
    assert "PASS: E1X full-payload repair ROM" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_full_payload_repair_rom.json").read_text())
    summary = report["summary"]

    assert report["status"] == "PASS"
    assert summary["failing_check_count"] == 0
    assert summary["payload_shard_record_count"] == 151_367
    assert summary["payload_loader_word_count"] == 1_627_034_880
    assert summary["normal_payload_remap_word_count"] == 279
    assert summary["high_failure_payload_remap_word_count"] == 3_012
    assert (
        summary["normal_payload_remap_words_sha256"]
        == "b941ac08aa1daaa9037e57443bf1700625fb598d79f04de20240d60ea9ba6ddd"
    )
    assert (
        summary["high_failure_payload_remap_words_sha256"]
        == "ef3422c00ace7d7d61ff761036c028ef0d72b53e8f909238373b6ebfcc432fe8"
    )
    assert summary["normal_payload_remap_program_checksum"] == 7_749_419_754_594_532_338
    assert summary["high_failure_payload_remap_program_checksum"] == 6_557_843_250_509_347_312
    assert summary["repair_rom_cocotb_testcases"] >= 16
    assert summary["boot_verified_rom_case_count"] == 3
    assert summary["combined_payload_repair_rom_checksum"] == 14_301_024_026_748_848_141
    assert (
        summary["case_summary_sha256"]
        == "b3b796f0aaf4d36a02eb25a248fd20df1ff06afeb4af988c982cbd4b41b5f2d9"
    )
    assert summary["residual_blocker"] == "silicon_fuse_burning_and_foundry_otp_macro_missing"
