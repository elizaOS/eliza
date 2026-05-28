from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_inventory import FEMBOT_BODY_GROUP_LINKS
from eliza_robot.asimov_1.fembot_mate_feature_cut_preview import (
    build_fembot_mate_feature_cut_preview_proof,
)


def _body_groups() -> list[dict[str, object]]:
    return [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]


def test_fembot_mate_feature_cut_preview_exports_reloadable_tool_steps() -> None:
    report = build_fembot_mate_feature_cut_preview_proof(_body_groups())

    assert report["schema"] == "asimov-fembot-mate-feature-cut-preview-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["links"] == 28
    assert report["summary"]["joint_feature_request_links"] == 27
    assert report["summary"]["feature_cut_tool_step_links"] == 27
    assert report["summary"]["feature_cut_tool_step_reloads"] == 27
    assert report["summary"]["feature_cut_tool_step_failure_links"] == 0
    assert report["summary"]["feature_cut_step_links"] == 27
    assert report["summary"]["feature_cut_step_reloads"] == 27
    assert report["summary"]["cut_feature_records"] == 189
    assert report["summary"]["source_cut_feature_records"] == 189
    assert report["summary"]["source_cut_fallback_links"] == 0
    assert report["summary"]["source_cut_fallback_link_names"] == []
    assert report["summary"]["source_cut_boolean_recovery_links"] == 1
    assert report["summary"]["source_cut_boolean_recovery_link_names"] == ["LEFT_ELBOW"]
    assert report["summary"]["wrist_fastener_redesign_applied_links"] == 2
    assert report["summary"]["negative_or_zero_tool_volume_links"] == []
    assert report["summary"]["negative_or_zero_cut_volume_links"] == []
    assert report["summary"]["source_cut_non_decreasing_volume_links"] == []
    assert report["summary"]["post_cut_collision_validated_links"] == 0
    assert report["summary"]["post_cut_structural_validated_links"] == 0

    links = {record["link"]: record for record in report["feature_cut_tool_steps"]}
    assert links["LEFT_KNEE"]["joint_feature_spec_count"] == 1
    assert links["LEFT_KNEE"]["cut_feature_count"] == 7
    assert links["LEFT_KNEE"]["export_ok"] is True
    assert links["LEFT_KNEE"]["reload_ok"] is True
    assert links["LEFT_KNEE"]["cut_export_ok"] is True
    assert links["LEFT_KNEE"]["cut_reload_ok"] is True
    assert links["LEFT_KNEE"]["tool_volume_m3"] > 0.0
    assert links["LEFT_KNEE"]["cut_volume_m3"] > 0.0
    assert links["LEFT_KNEE"]["removed_volume_m3"] > 0.0
    assert links["LEFT_KNEE"]["step_sha256"]
    assert links["LEFT_KNEE"]["cut_step_sha256"]
    assert links["LEFT_ELBOW"]["source_cut_fallback_strategy"] is None
    assert links["LEFT_ELBOW"]["source_cut_boolean_recovery_strategy"] == (
        "segmented_counterbore_boolean"
    )
    assert links["LEFT_ELBOW"]["source_cut_feature_count"] == 7
    assert links["LEFT_ELBOW"]["cut_feature_count"] == 7
    assert links["LEFT_WRIST_YAW"]["wrist_fastener_redesign_applied"] is True
    assert links["RIGHT_WRIST_YAW"]["wrist_fastener_redesign_applied"] is True


def test_fembot_mate_feature_cut_preview_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "fembot-mate-feature-cut-preview.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_mate_feature_cut_preview.py",
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
    assert report["schema"] == "asimov-fembot-mate-feature-cut-preview-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert '"feature_cut_tool_step_links": 27' in proc.stdout
