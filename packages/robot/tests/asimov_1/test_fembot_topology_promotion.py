from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_topology_promotion import (
    build_fembot_topology_promotion_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS


def _generated_cad_report() -> dict | None:
    path = ASIMOV_PARAM_PROOFS / "fembot-generated-cad-envelope.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None


def _topology_report() -> dict | None:
    path = ASIMOV_PARAM_PROOFS / "fembot-topology.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None


def test_fembot_topology_promotion_selects_clean_step_set() -> None:
    report = build_fembot_topology_promotion_proof(
        generated_cad_report=_generated_cad_report(),
        topology_report=_topology_report(),
    )

    assert report["schema"] == "asimov-fembot-topology-promotion-v1"
    assert report["ok"] is True
    assert report["accepted"] is True
    assert report["summary"]["links"] == 28
    assert report["summary"]["missing_links"] == []
    assert report["summary"]["promoted_original_step_links"] == 19
    assert report["summary"]["promoted_repair_preview_links"] == 9
    assert report["summary"]["promoted_step_exports"] == 28
    assert report["summary"]["validated_promoted_meshes"] == 28
    assert report["summary"]["accepted_promoted_meshes"] == 28
    assert report["summary"]["max_boundary_edges"] == 0
    assert report["summary"]["max_nonmanifold_edges"] == 0
    assert report["summary"]["max_degenerate_faces"] == 0

    records = {record["link"]: record for record in report["records"]}
    assert records["WAIST_YAW"]["promotion_source"] == "accepted_original_step"
    assert records["LEFT_KNEE"]["promotion_source"] == "repair_preview"
    assert records["LEFT_KNEE"]["repair_preview_envelope_preserved"] is True
    assert records["LEFT_KNEE"]["promoted_step_path"].endswith("left_knee.step")


def test_fembot_topology_promotion_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "fembot-topology-promotion.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_topology_promotion.py",
            "--output",
            str(output),
            "--require-accepted",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert output.is_file()
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["accepted"] is True
    assert '"promoted_repair_preview_links": 9' in proc.stdout
    assert '"accepted_promoted_meshes": 28' in proc.stdout
