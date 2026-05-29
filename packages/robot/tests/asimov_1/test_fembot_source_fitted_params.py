from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_inventory import FEMBOT_BODY_GROUP_LINKS
from eliza_robot.asimov_1.fembot_source_fitted_params import (
    build_fembot_source_fitted_params_proof,
    write_fembot_source_fitted_params_manifests,
)


def _body_groups() -> list[dict[str, object]]:
    return [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]


def test_fembot_source_fitted_params_exports_real_control_ring_manifests(tmp_path) -> None:
    report = build_fembot_source_fitted_params_proof(
        _body_groups(),
        output_root=tmp_path / "source_fitted_parts",
    )
    paths = write_fembot_source_fitted_params_manifests(
        report,
        output_root=tmp_path / "source_fitted_parts",
    )

    assert report["schema"] == "asimov-fembot-source-fitted-params-v1"
    assert report["ok"] is True
    assert report["accepted"] is True
    assert report["summary"]["links"] == 28
    assert report["summary"]["missing_links"] == []
    assert report["summary"]["step_export_reload_links"] == 28
    assert report["summary"]["source_control_bbox_preserved_links"] == 28
    assert report["summary"]["source_reloaded_envelope_preserved_links"] == 28
    assert report["summary"]["source_reloaded_envelope_tolerance_m"] == 0.005
    assert report["summary"]["rectangular_control_ring_tables"] == 28
    assert report["summary"]["minimum_control_ring_count"] >= 2
    assert report["summary"]["minimum_control_points_per_ring"] >= 16
    assert report["summary"]["max_source_reloaded_bbox_abs_delta_m"] <= 0.005
    assert len(paths) == 28

    by_link = {record["link"]: record for record in report["manifests"]}
    waist = by_link["WAIST_YAW"]
    assert waist["surface_intent"] == "smooth"
    assert waist["generated_step"]["export_ok"] is True
    assert waist["fit_checks"]["source_reloaded_bbox_preserved"] is True
    assert len(waist["control_rings"]) == waist["control_ring_count"]
    assert len(waist["control_rings"][0]) == waist["control_points_per_ring"]
    assert waist["adjustable_parameters"]["keep_source_bbox_normalization"] is True

    manifest = json.loads(paths[0].read_text(encoding="utf-8"))
    assert manifest["schema"] == "asimov-fembot-source-fitted-params-v1"
    assert manifest["control_rings"]


def test_fembot_source_fitted_params_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "fembot-source-fitted-params.json"
    manifest_root = tmp_path / "source_fitted_parts"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_source_fitted_params.py",
            "--output",
            str(output),
            "--manifest-root",
            str(manifest_root),
            "--require-accepted",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert proc.returncode == 0
    assert output.is_file()
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["schema"] == "asimov-fembot-source-fitted-params-v1"
    assert report["accepted"] is True
    assert '"source_control_bbox_preserved_links": 28' in proc.stdout
    assert len(list(manifest_root.glob("*.source-fitted-loft.json"))) == 28
