from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_inventory import FEMBOT_BODY_GROUP_LINKS
from eliza_robot.asimov_1.fembot_mate_features import (
    build_fembot_mate_features_plan_proof,
)


def _body_groups() -> list[dict[str, object]]:
    return [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]


def test_fembot_mate_features_plan_maps_kinematic_and_supplier_mates() -> None:
    report = build_fembot_mate_features_plan_proof(_body_groups())

    assert report["schema"] == "asimov-fembot-mate-features-plan-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["links"] == 28
    assert report["summary"]["body_link_records"] == 28
    assert report["summary"]["kinematic_proxy_ready_links"] == 28
    assert report["summary"]["joint_mate_links"] == 27
    assert report["summary"]["actuated_mate_links"] == 25
    assert report["summary"]["supplier_pocket_links"] == 8
    assert report["summary"]["supplier_mate_feature_proxy_ready_links"] == 8
    assert report["summary"]["supplier_exact_placement_ready_links"] == 0
    assert report["summary"]["exact_bore_fastener_measurement_ready_links"] == 0
    assert len(report["summary"]["missing_exact_bore_fastener_measurement_links"]) == 28
    assert report["summary"]["required_mate_feature_records"] > 100

    links = {record["link"]: record for record in report["links"]}
    assert links["LEFT_KNEE"]["joint_names"]
    assert links["LEFT_KNEE"]["actuated_joint_names"]
    assert links["LEFT_KNEE"]["supplier_pocket_plan_count"] > 0
    assert links["LEFT_KNEE"]["supplier_mate_feature_proxy_ready"] is True
    assert links["LEFT_KNEE"]["supplier_exact_placement_ready"] is False
    assert links["LEFT_KNEE"]["exact_bore_fastener_measurements_ready"] is False
    assert "bearing_or_ring_seat" in links["LEFT_KNEE"]["required_mate_features"]
    assert links["IMU_ORIGIN"]["parent_body"] is None
    assert links["IMU_ORIGIN"]["child_links"]


def test_fembot_mate_features_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "fembot-mate-features-plan.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_mate_features_plan.py",
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
    assert report["schema"] == "asimov-fembot-mate-features-plan-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert '"supplier_mate_feature_proxy_ready_links": 8' in proc.stdout
