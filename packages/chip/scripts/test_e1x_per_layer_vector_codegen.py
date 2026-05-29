from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_per_layer_vector_codegen_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_per_layer_vector_codegen.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X per-layer vector codegen" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_per_layer_vector_codegen.json").read_text())
    assert report["status"] == "PASS"
    summary = report["summary"]
    assert summary["failing_check_count"] == 0
    assert summary["codegen_layer_count"] == 283
    assert summary["template_body_instruction_estimate"] == 87_876_679_680
    assert summary["loop_control_instruction_estimate"] == 6_517_209_600
    assert summary["total_kernel_instruction_estimate"] == 94_393_889_280
    assert summary["routing_color_count"] == 24
    assert (
        summary["per_layer_codegen_sha256"]
        == "3815c04bfb38c664d3215e0b268e6ed8d801a7a075a1dab6ab1174d4e4635956"
    )
    assert (
        summary["template_sha256"]
        == "3e98428c1de7d7f7ca9c549bcdc48699fddaaf0da38bf37a723c68f3f712b18c"
    )
    assert (
        summary["skeleton_sha256"]
        == "9422315bcb1a9f158be7d795c6fc386a3c65e31907b80cb5a3cc743d4145dfd3"
    )
    assert summary["residual_blocker"] == "full_output_vector_kernel_execution_missing"
