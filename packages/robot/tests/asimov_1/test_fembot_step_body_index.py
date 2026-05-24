from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_inventory import collect_fembot_inventory
from eliza_robot.asimov_1.fembot_step_body_index import build_fembot_step_body_index_proof


def test_fembot_step_body_index_loads_bounded_fabrication_steps_with_cad_kernel() -> None:
    inventory = collect_fembot_inventory()
    report = build_fembot_step_body_index_proof(
        inventory["body_groups"],
        max_files_per_group=1,
    )

    assert report["schema"] == "asimov-fembot-step-body-index-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["body_groups"] == 5
    assert report["summary"]["main_step_exists"] is True
    assert report["summary"]["main_step_size_bytes"] > 200_000_000
    assert report["summary"]["main_assembly_cad_index_requested"] is False
    assert report["summary"]["main_assembly_loaded"] is False
    assert report["summary"]["unique_step_files_indexed"] >= 4
    assert report["summary"]["failed_step_files"] == 0
    assert report["summary"]["loaded_step_files"] == report["summary"]["unique_step_files_indexed"]
    assert report["summary"]["body_count"] >= report["summary"]["loaded_step_files"]
    assert report["summary"]["full_index"] is False
    assert report["summary"]["fabrication_class_counts"]["ALU_7075"] > 0
    assert report["main_assembly_step"]["exists"] is True
    assert report["main_assembly_step"]["sha256"]
    assert report["main_assembly_step"]["cad"]["skipped"] is True

    groups = {group["group"]: group for group in report["body_groups"]}
    assert groups["torso"]["assembly_candidates"] == ["200", "700"]
    assert groups["head"]["assembly_candidates"] == ["100"]
    assert groups["arm"]["assembly_candidates"] == ["300", "400"]
    assert groups["leg"]["assembly_candidates"] == ["500", "600"]
    assert groups["foot"]["assembly_candidates"] == ["500", "600"]

    for group in report["body_groups"]:
        assert group["indexed_step_files"] == 1
        record = group["records"][0]
        assert record["sha256"]
        assert record["cad"]["loaded"] is True
        assert record["cad"]["body_count"] >= 1
        body = record["cad"]["bodies"][0]
        assert body["bbox_mm"]["xmax"] > body["bbox_mm"]["xmin"]
        if body["volume_mm3"] is not None:
            assert body["volume_mm3"] >= 0


def test_fembot_step_body_index_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "step-body-index.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_step_body_index.py",
            "--output",
            str(output),
            "--max-files-per-group",
            "1",
            "--require-accepted",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert output.is_file()
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["schema"] == "asimov-fembot-step-body-index-v1"
    assert proc.returncode == (0 if report["accepted"] else 2)
    assert '"failed_step_files": 0' in proc.stdout
