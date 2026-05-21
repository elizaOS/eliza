from __future__ import annotations

from eliza_robot.asimov_1.constants import ASIMOV1_FULL_ACTION_DIM
from eliza_robot.asimov_1.livekit_dry_run import validate_asimov_livekit_dry_run


def test_asimov_livekit_dry_run_exercises_real_backend_command_surface() -> None:
    report = validate_asimov_livekit_dry_run()

    assert report["ok"] is True
    assert report["command_topic"] == "commands"
    assert report["checks"]["published_count"] is True
    assert report["checks"]["command_topic"] is True
    assert report["checks"]["sequence_order"] is True
    assert report["checks"]["telemetry_joint_width"] is True
    assert len(report["published_commands"]) == 3
    assert "mode" in report["published_commands"][0]
    assert "velocity" in report["published_commands"][1]
    assert "trajectory" in report["published_commands"][2]
    segment = report["published_commands"][2]["trajectory"]["full"]["segments"][0]
    assert len(segment["positions"]) == ASIMOV1_FULL_ACTION_DIM
    assert report["telemetry"]["sequence"] == 77
