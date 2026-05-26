from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_inventory import FEMBOT_BODY_GROUP_LINKS
from eliza_robot.asimov_1.fembot_wrist_fastener_redesign import (
    build_fembot_wrist_fastener_redesign_proof,
)


def _body_groups() -> list[dict[str, object]]:
    return [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]


def test_fembot_wrist_fastener_redesign_fits_current_thin_envelope() -> None:
    report = build_fembot_wrist_fastener_redesign_proof(_body_groups())

    assert report["schema"] == "asimov-fembot-wrist-fastener-redesign-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["target_links"] == 2
    assert report["summary"]["redesign_candidate_links"] == 2
    assert report["summary"]["redesign_fits_current_envelope_links"] == 2
    assert report["summary"]["remaining_spatial_fit_failures_after_redesign"] == 0
    assert report["summary"]["min_revised_fit_margin_m"] > 0.0

    redesigns = {record["link"]: record for record in report["redesigns"]}
    assert set(redesigns) == {"LEFT_WRIST_YAW", "RIGHT_WRIST_YAW"}
    assert redesigns["LEFT_WRIST_YAW"]["original_fit_margin_m"] < 0.0
    assert redesigns["LEFT_WRIST_YAW"]["revised_fit_margin_m"] > 0.0
    assert redesigns["LEFT_WRIST_YAW"]["preserved_bearing_outer_radius_m"] > 0.0
    assert (
        redesigns["LEFT_WRIST_YAW"]["redesign_strategy"]
        == "reduce_wrist_bolt_circle_preserve_bore_and_bearing"
    )


def test_fembot_wrist_fastener_redesign_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "fembot-wrist-fastener-redesign.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_wrist_fastener_redesign.py",
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
    assert report["schema"] == "asimov-fembot-wrist-fastener-redesign-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert '"remaining_spatial_fit_failures_after_redesign": 0' in proc.stdout
