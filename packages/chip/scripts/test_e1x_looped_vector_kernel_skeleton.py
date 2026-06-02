from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_looped_vector_kernel_skeleton_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_looped_vector_kernel_skeleton.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X looped vector-kernel skeleton" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_looped_vector_kernel_skeleton.json").read_text())
    assert report["status"] == "PASS"
    summary = report["summary"]
    assert summary["failing_check_count"] == 0
    assert summary["skeleton_instruction_words"] == 11
    assert (
        summary["skeleton_sha256"]
        == "9422315bcb1a9f158be7d795c6fc386a3c65e31907b80cb5a3cc743d4145dfd3"
    )
    assert summary["branch_instruction_count"] == 4
    assert summary["opimm_instruction_count"] == 6
    assert summary["full_output_row_count"] == 2_608_640
    assert summary["vector_word_op_count"] == 1_627_345_920
    assert summary["template_instruction_words"] == 54
    assert summary["template_instruction_estimate"] == 87_876_679_680
    assert summary["loop_control_instruction_estimate"] == 6_517_209_600
    assert summary["combined_template_plus_loop_instruction_estimate"] == 94_393_889_280
    assert summary["residual_blocker"] == "per_layer_looped_vector_kernel_codegen_execution_missing"
