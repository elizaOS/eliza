from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_inventory import collect_fembot_inventory
from eliza_robot.asimov_1.fembot_source_manifest import build_fembot_source_manifest_proof


def test_fembot_source_manifest_splits_step_candidates_by_body_group() -> None:
    inventory = collect_fembot_inventory()
    report = build_fembot_source_manifest_proof(inventory["body_groups"])

    assert report["schema"] == "asimov-fembot-source-manifest-v1"
    assert report["ok"] is True
    assert report["accepted"] is True
    assert report["summary"]["body_groups"] == 5
    assert report["summary"]["links"] == 28
    assert report["summary"]["unique_step_files"] > 0
    assert report["summary"]["group_step_file_references"] >= report["summary"]["unique_step_files"]
    assert report["summary"]["missing_assemblies"] == []
    assert report["summary"]["exact_link_assignments"] == 0
    assert report["summary"]["controlled_loft_assignments"] == 28
    assert report["summary"]["unresolved_links"] == 0
    assert report["summary"]["fabrication_class_counts"]["ASSEMBLY"] > 0
    assert report["summary"]["fabrication_class_counts"]["OFF_THE_SHELF"] > 0

    groups = {group["group"]: group for group in report["body_groups"]}
    assert groups["torso"]["assembly_candidates"] == ["200", "700"]
    assert groups["head"]["assembly_candidates"] == ["100"]
    assert groups["arm"]["assembly_candidates"] == ["300", "400"]
    assert groups["leg"]["assembly_candidates"] == ["500", "600"]
    assert groups["foot"]["assembly_candidates"] == ["500", "600"]

    for group in groups.values():
        assert group["step_file_count"] > 0
        assert group["exact_link_assignments"] == []
        assert len(group["controlled_loft_assignments"]) == len(group["links"])
        assert group["unresolved_links"] == []
        assert group["accepted"] is True
        assert all(record["sha256"] for record in group["step_files"])


def test_fembot_inventory_surfaces_source_manifest_status() -> None:
    report = collect_fembot_inventory()

    assert report["source_manifest"]["ok"] is True
    assert report["source_manifest"]["accepted"] is True
    assert report["source_manifest"]["summary"]["controlled_loft_assignments"] == 28
    assert report["source_manifest"]["summary"]["unresolved_links"] == 0
    assert report["source_manifest"]["summary"]["exact_link_assignments"] == 0
    for group in report["body_groups"]:
        assert "source_step_or_controlled_loft" not in group["missing_proofs"]


def test_fembot_source_manifest_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "source-manifest.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_source_manifest.py",
            "--output",
            str(output),
            "--require-accepted",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert output.is_file()
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["schema"] == "asimov-fembot-source-manifest-v1"
    assert proc.returncode == (0 if report["accepted"] else 2)
    assert '"accepted": true' in proc.stdout
