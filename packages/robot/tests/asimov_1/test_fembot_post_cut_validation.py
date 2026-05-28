from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_inventory import FEMBOT_BODY_GROUP_LINKS
from eliza_robot.asimov_1.fembot_post_cut_validation import (
    build_fembot_post_cut_validation_proof,
)


def _body_groups() -> list[dict[str, object]]:
    return [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]


def test_fembot_post_cut_validation_screens_source_cut_steps() -> None:
    report = build_fembot_post_cut_validation_proof(_body_groups())

    assert report["schema"] == "asimov-fembot-post-cut-validation-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["links"] == 27
    assert report["summary"]["post_cut_geometry_validated_links"] == 27
    assert report["summary"]["post_cut_topology_validated_links"] == 27
    assert report["summary"]["post_cut_manufacturing_screen_pass_links"] == 27
    assert report["summary"]["post_cut_structural_screen_pass_links"] == 6
    assert report["summary"]["post_cut_fragmented_links"] == 16
    assert report["summary"]["post_cut_high_volume_loss_links"] == 7
    assert report["summary"]["post_cut_source_cut_fallback_links"] == 0
    assert report["summary"]["post_cut_boolean_recovery_links"] == 1

    records = {record["link"]: record for record in report["post_cut_validations"]}
    assert records["LEFT_ELBOW"]["source_cut_boolean_recovery_strategy"] == (
        "segmented_counterbore_boolean"
    )
    assert records["LEFT_ELBOW"]["source_cut_feature_count"] == 7
    assert records["LEFT_ELBOW"]["geometry_validated"] is True
    assert records["LEFT_ELBOW"]["manufacturing_screen_pass"] is True
    assert records["LEFT_ELBOW"]["structural_screen_pass"] is True
    assert records["LEFT_ANKLE_A"]["structural_screen_pass"] is False
    assert records["LEFT_ANKLE_A"]["fragmented_cut_body"] is True
    assert records["LEFT_ANKLE_A"]["structural_volume_loss_warning"] is True


def test_fembot_post_cut_validation_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "fembot-post-cut-validation.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_post_cut_validation.py",
            "--output",
            str(output),
            "--require-accepted",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert proc.returncode == 2
    assert output.is_file()
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["ok"] is True
    assert report["accepted"] is False
    assert '"post_cut_geometry_validated_links": 27' in proc.stdout
