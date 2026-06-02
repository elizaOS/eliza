from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_vector_kernel_template_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_vector_kernel_template.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X vector-kernel template" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_vector_kernel_template.json").read_text())
    assert report["status"] == "PASS"
    summary = report["summary"]
    assert summary["failing_check_count"] == 0
    assert summary["template_instruction_words"] == 54
    assert (
        summary["template_sha256"]
        == "3e98428c1de7d7f7ca9c549bcdc48699fddaaf0da38bf37a723c68f3f712b18c"
    )
    assert summary["load_instruction_count"] == 9
    assert summary["opimm_instruction_count"] == 26
    assert summary["op_instruction_count"] == 16
    assert summary["store_instruction_count"] == 2
    assert summary["vector_word_op_count"] == 1_627_345_920
    assert summary["full_template_instruction_estimate"] == 87_876_679_680
    assert (
        summary["workplan_sha256"]
        == "ce900472ec1f82ecc128179c77d4a04f09bbff546dc3dfbfbe36e34d018558e2"
    )
    assert summary["residual_blocker"] == "looped_vector_kernel_codegen_and_full_execution_missing"
