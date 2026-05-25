from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_topology import build_fembot_topology_proof
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS


def _generated_cad_report() -> dict | None:
    path = ASIMOV_PARAM_PROOFS / "fembot-generated-cad-envelope.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None


def test_fembot_topology_proof_measures_generated_step_meshes() -> None:
    report = build_fembot_topology_proof(generated_cad_report=_generated_cad_report())

    assert report["schema"] == "asimov-fembot-topology-proof-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["links"] == 28
    assert report["summary"]["mesh_exports"] == 28
    assert report["summary"]["single_solid_source_steps"] == 28
    assert report["summary"]["watertight_meshes"] == 19
    assert report["summary"]["expected_component_count_matches"] == 18
    assert report["summary"]["waist_single_shell_no_cutout_topology_links"] == 1
    assert report["summary"]["accepted_topologies"] == 19
    assert report["summary"]["topology_failure_links"] == 9
    assert report["summary"]["repair_preview_candidates"] == 9
    assert report["summary"]["repair_preview_exports"] == 9
    assert report["summary"]["repair_preview_reloads"] == 9
    assert report["summary"]["repair_preview_mesh_exports"] == 9
    assert report["summary"]["repair_preview_accepted_topologies"] == 9
    assert report["summary"]["repair_preview_failure_links"] == 0
    assert report["summary"]["repair_preview_envelope_preserved_links"] == 9
    assert report["summary"]["repair_preview_height_preserved_links"] == 9
    assert report["summary"]["repair_preview_max_extent_abs_error_m"] < 1.0e-9
    assert report["summary"]["repair_preview_max_height_abs_error_m"] < 1.0e-9
    assert report["summary"]["repair_preview_max_center_abs_error_m"] < 1.0e-9
    assert report["summary"]["repair_preview_max_abs_volume_delta_fraction"] > 0.0
    assert (
        report["summary"]["repair_preview_promotable_by_topology_and_envelope"]
        is True
    )
    assert report["summary"]["topology_resolved_links"] == 28
    assert report["summary"]["topology_resolved_by_original_export_links"] == 19
    assert report["summary"]["topology_resolved_by_repair_preview_links"] == 9
    assert report["summary"]["topology_unresolved_links"] == 0
    assert report["summary"]["topology_unresolved_link_names"] == []
    assert report["summary"]["export_failures"] == 0
    assert report["summary"]["max_boundary_edges"] == 2
    assert report["summary"]["max_nonmanifold_edges"] == 4
    assert report["summary"]["max_degenerate_faces"] == 4
    assert report["summary"]["max_component_count"] == 6

    records = {record["link"]: record for record in report["link_topology"]}
    assert records["LEFT_TOE"]["accepted"] is True
    assert records["LEFT_TOE"]["component_count"] == 1
    assert records["LEFT_TOE"]["expected_component_count"] == 1
    assert records["LEFT_KNEE"]["accepted"] is False
    assert records["LEFT_KNEE"]["boundary_edges"] > 0
    assert records["LEFT_KNEE"]["expected_component_count"] == 2
    assert records["WAIST_YAW"]["accepted"] is True
    assert records["WAIST_YAW"]["component_count"] == 1
    assert records["WAIST_YAW"]["expected_component_count"] == 2
    assert records["WAIST_YAW"]["waist_single_shell_no_cutout_accepted"] is True

    repair_records = {record["link"]: record for record in report["repair_preview_topology"]}
    assert sorted(repair_records) == [
        "LEFT_ANKLE_A",
        "LEFT_KNEE",
        "LEFT_SHOULDER_YAW",
        "LEFT_WRIST_YAW",
        "NECK_YAW",
        "RIGHT_ANKLE_A",
        "RIGHT_KNEE",
        "RIGHT_SHOULDER_YAW",
        "RIGHT_WRIST_YAW",
    ]
    for link, repair in repair_records.items():
        assert repair["accepted"] is True
        assert repair["boundary_edges"] == 0
        assert repair["nonmanifold_edges"] == 0
        assert repair["degenerate_faces"] == 0
        assert repair["component_count"] == repair["expected_component_count"] == 2
        assert repair["envelope_preserved"] is True
        assert repair["height_preserved"] is True
        assert repair["extent_max_abs_error_m"] < 1.0e-9

    deltas = {record["link"]: record for record in report["repair_preview_deltas"]}
    assert set(deltas) == set(repair_records)
    assert deltas["LEFT_ANKLE_A"]["volume_delta_fraction"] > 0.0
    assert deltas["LEFT_KNEE"]["envelope_preserved"] is True


def test_fembot_topology_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "fembot-topology.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_topology_proof.py",
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
    assert report["schema"] == "asimov-fembot-topology-proof-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert proc.returncode == 2
    assert '"topology_failure_links": 9' in proc.stdout
    assert '"repair_preview_accepted_topologies": 9' in proc.stdout
    assert '"topology_resolved_links": 28' in proc.stdout
    assert '"repair_preview_promotable_by_topology_and_envelope": true' in proc.stdout
