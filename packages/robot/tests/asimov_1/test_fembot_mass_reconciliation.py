from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_inventory import FEMBOT_BODY_GROUP_LINKS
from eliza_robot.asimov_1.fembot_mass_reconciliation import (
    build_fembot_mass_reconciliation_plan_proof,
)


def _body_groups() -> list[dict[str, object]]:
    return [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]


def test_fembot_mass_reconciliation_plan_classifies_mass_property_actions() -> None:
    report = build_fembot_mass_reconciliation_plan_proof(_body_groups())

    assert report["schema"] == "asimov-fembot-mass-reconciliation-plan-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["links"] == 28
    assert report["summary"]["mass_out_of_tolerance_links"] == 26
    assert report["summary"]["inertia_out_of_tolerance_links"] == 25
    assert report["summary"]["missing_hardware_measurement_links"] == 28
    assert report["summary"]["add_internal_mass_or_density_retarget_links"] == 23
    assert report["summary"]["reduce_shell_mass_or_compiled_mass_retarget_links"] == 3
    assert report["summary"]["total_required_added_mass_to_match_compiled_kg"] > 15.0
    assert report["summary"]["max_required_added_mass_to_match_compiled_kg"] > 3.7
    assert report["summary"]["max_mass_scale_to_compiled"] > 8.0
    assert report["summary"]["max_inertia_scale_to_compiled"] > 7.0
    assert (
        report["summary"]["action_counts"][
            "retarget_inertia_tensor_or_add_distributed_ballast"
        ]
        == 25
    )

    links = {record["link"]: record for record in report["links"]}
    assert links["WAIST_YAW"]["mass_action"] == (
        "add_internal_mass_or_retarget_material_density"
    )
    assert links["WAIST_YAW"]["required_added_mass_to_match_compiled_kg"] > 3.7
    assert links["LEFT_TOE"]["mass_action"] == (
        "reduce_shell_mass_or_retarget_compiled_body_mass"
    )
    assert links["LEFT_HIP_YAW"]["mass_action"] == (
        "mass_within_tolerance_pending_hardware_measurement"
    )
    assert links["LEFT_HIP_YAW"]["hardware_measurement_present"] is False


def test_fembot_mass_reconciliation_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "fembot-mass-reconciliation-plan.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_mass_reconciliation_plan.py",
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
    assert report["schema"] == "asimov-fembot-mass-reconciliation-plan-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert '"mass_out_of_tolerance_links": 26' in proc.stdout
