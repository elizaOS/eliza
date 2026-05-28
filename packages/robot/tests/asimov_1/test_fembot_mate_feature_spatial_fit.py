from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_inventory import FEMBOT_BODY_GROUP_LINKS
from eliza_robot.asimov_1.fembot_mate_feature_spatial_fit import (
    build_fembot_mate_feature_spatial_fit_proof,
)


def _body_groups() -> list[dict[str, object]]:
    return [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]


def test_fembot_mate_feature_spatial_fit_flags_thin_wrist_fastener_limits() -> None:
    report = build_fembot_mate_feature_spatial_fit_proof(_body_groups())

    assert report["schema"] == "asimov-fembot-mate-feature-spatial-fit-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["joint_feature_records"] == 27
    assert report["summary"]["fits_current_envelope_records"] == 25
    assert report["summary"]["redesign_required_records"] == 2
    assert report["summary"]["redesign_required_links"] == 2
    assert report["summary"]["worst_fit_margin_m"] < 0.0
    assert report["summary"]["action_counts"] == {
        "reduce_fastener_pattern_or_use_inserted_off_axis_boss": 2,
    }

    by_link = {record["link"]: record for record in report["spatial_fit"]}
    assert by_link["LEFT_KNEE"]["fits_current_envelope"] is True
    assert by_link["LEFT_KNEE"]["fit_margin_m"] > 0.0
    assert by_link["LEFT_WRIST_YAW"]["fits_current_envelope"] is False
    assert by_link["RIGHT_WRIST_YAW"]["fits_current_envelope"] is False
    assert (
        by_link["LEFT_WRIST_YAW"]["redesign_action"]
        == "reduce_fastener_pattern_or_use_inserted_off_axis_boss"
    )


def test_fembot_mate_feature_spatial_fit_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "fembot-mate-feature-spatial-fit.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_mate_feature_spatial_fit.py",
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
    assert report["schema"] == "asimov-fembot-mate-feature-spatial-fit-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert '"redesign_required_links": 2' in proc.stdout
