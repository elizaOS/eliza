from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_inventory import FEMBOT_BODY_GROUP_LINKS
from eliza_robot.asimov_1.fembot_package_redesign import (
    build_fembot_package_redesign_plan_proof,
)


def _body_groups() -> list[dict[str, object]]:
    return [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]


def test_fembot_package_redesign_plan_classifies_height_preservation_blockers() -> None:
    report = build_fembot_package_redesign_plan_proof(_body_groups())

    assert report["schema"] == "asimov-fembot-package-redesign-plan-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["component_or_packaging_redesign_required_links"] == 16
    assert report["summary"]["height_preserving_resolution_links"] == 10
    assert report["summary"]["major_package_redesign_links"] == 13
    assert report["summary"]["localized_package_redesign_links"] == 3
    assert report["summary"]["evidence_closure_links"] == 0
    assert report["summary"]["max_required_z_stack_reduction_m"] > 0.038
    assert report["summary"]["max_required_xy_area_tradeoff_fraction"] > 0.48
    assert report["summary"]["action_counts"]["actuator_package_redesign"] == 15
    assert report["summary"]["action_counts"]["joint_bearing_stack_redesign"] == 13
    assert report["summary"]["action_counts"]["collision_keepout_refit_or_local_shell_relief"] == 9
    assert report["summary"]["action_counts"]["sensor_site_relocation_or_reserved_boss"] == 1
    assert report["summary"]["action_counts"]["supplier_vendor_pocket_qualification"] == 2
    assert report["summary"]["action_counts"]["z_stack_reduction_required"] == 16
    assert report["summary"]["action_counts"]["xy_envelope_tradeoff_required"] == 6

    links = {record["link"]: record for record in report["redesign_links"]}
    assert "sensor_site_relocation_or_reserved_boss" in {
        action["action"] for action in links["IMU_ORIGIN"]["actions"]
    }
    assert "supplier_vendor_pocket_qualification" in {
        action["action"] for action in links["LEFT_ANKLE_A"]["actions"]
    }
    assert links["RIGHT_WRIST_YAW"]["severity"] == "major_package_redesign"


def test_fembot_package_redesign_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "fembot-package-redesign-plan.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_package_redesign_plan.py",
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
    assert report["schema"] == "asimov-fembot-package-redesign-plan-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert proc.returncode == 2
    assert '"component_or_packaging_redesign_required_links": 16' in proc.stdout
