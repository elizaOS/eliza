from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_inventory import FEMBOT_BODY_GROUP_LINKS, collect_fembot_inventory
from eliza_robot.asimov_1.fembot_visual_review import build_fembot_visual_review_proof


def _body_groups() -> list[dict[str, object]]:
    return [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]


def test_fembot_visual_review_writes_group_svg_renders(tmp_path) -> None:
    report = build_fembot_visual_review_proof(
        _body_groups(),
        output_root=tmp_path / "visual-review",
    )

    assert report["schema"] == "asimov-fembot-visual-review-proof-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["body_groups"] == 5
    assert report["summary"]["render_paths"] == 15
    assert report["summary"]["missing_render_paths"] == []
    assert report["summary"]["front_envelope_max_width_m"] > 0.0
    assert report["summary"]["side_envelope_max_depth_m"] > 0.0
    assert report["summary"]["minimum_slenderness_ratio"] > 0.0

    groups = {group["group"]: group for group in report["body_groups"]}
    assert groups["torso"]["front_envelope_m"]["height_m"] > 0.0
    assert groups["arm"]["three_quarter_review"]["review_required"] is True
    for path in groups["leg"]["render_paths"].values():
        assert path.endswith(".svg")
        assert (tmp_path / "visual-review" / "leg" / path.split("/")[-1]).is_file()


def test_fembot_inventory_surfaces_visual_review_status() -> None:
    report = collect_fembot_inventory()

    assert report["visual_review"]["ok"] is True
    assert report["visual_review"]["accepted"] is False
    assert report["visual_review"]["summary"]["body_groups"] == 5
    assert report["visual_review"]["summary"]["render_paths"] == 15
    assert report["visual_review"]["summary"]["missing_render_paths"] == []
    assert report["visual_motion_media"]["ok"] is True
    assert report["visual_motion_media"]["accepted"] is False
    assert report["visual_motion_media"]["summary"]["screenshot_count"] == 6
    assert report["visual_motion_media"]["summary"]["video_frame_count"] == 144
    assert report["visual_motion_media"]["summary"]["joint_count"] == 27
    for group in report["body_groups"]:
        assert "visual_review" in group["missing_proofs"]
        assert "visual_motion_media" not in group["missing_proofs"]


def test_fembot_visual_review_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "visual-review.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_visual_review_proof.py",
            "--output",
            str(output),
            "--render-root",
            str(tmp_path / "renders"),
            "--require-accepted",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert output.is_file()
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["schema"] == "asimov-fembot-visual-review-proof-v1"
    assert proc.returncode == (0 if report["accepted"] else 2)
    assert '"accepted": false' in proc.stdout
