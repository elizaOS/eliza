from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_waist_yaw_no_cutout import build_waist_yaw_no_cutout_proof


def test_waist_yaw_generator_exports_smooth_loft_without_front_m_cutout() -> None:
    proc = subprocess.run(
        [sys.executable, "cad/asimov-feminine/param/parts/WAIST_YAW.py"],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "ALL CHECKS PASS: True" in proc.stdout

    report = build_waist_yaw_no_cutout_proof()

    assert report["schema"] == "asimov-fembot-waist-yaw-no-cutout-proof-v1"
    assert report["accepted"] is True
    assert report["method"] == "convex_hull_cross_section_rings_to_parametric_loft"
    assert report["source_fragmented_sections"] == len(report["section_levels_m"])
    assert report["topology"]["watertight"] is True
    assert report["topology"]["component_count"] == 1
    assert report["topology"]["euler_number"] == 2
    assert report["generated_sections_ok"] is True
    for section in report["generated_sections"]:
        assert section["loop_count"] == 1
        assert section["front_loop_count"] == 1
        assert section["max_closure_gap_m"] == 0.0


def test_waist_yaw_no_cutout_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "waist-yaw-no-cutout.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_waist_yaw_no_cutout_proof.py",
            "--output",
            str(output),
            "--require-accepted",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert proc.returncode == 0, proc.stdout + proc.stderr
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["accepted"] is True
    assert '"accepted": true' in proc.stdout
