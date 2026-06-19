from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from scripts import record_agent_videos
from scripts.validate_multi_robot_training_readiness import (
    DEFAULT_COMMANDS,
    DEFAULT_PROFILES,
    _check_video_evidence,
    _manifest_entry_exit_ok,
    validate,
)


def _write_video(path: Path, size: int = 2048) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"0" * size)


def _write_telemetry(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"rollout_ok": True, "steps_executed": 1, "steps_requested": 1}),
        encoding="utf-8",
    )


def _write_manifest(
    root: Path,
    profiles: list[str],
    commands: list[str],
    *,
    combined: bool,
) -> None:
    entries = []
    for profile in profiles:
        expected = record_agent_videos.expected_video_names(
            profile,
            commands,
            record_combined=combined,
        )
        expected_telemetry = record_agent_videos.expected_telemetry_names(
            profile,
            commands,
            record_combined=combined,
        )
        expected_contact_sheets = record_agent_videos.expected_contact_sheet_names(
            profile,
            commands,
            record_combined=combined,
        )
        entries.append(
            {
                "profile": profile,
                "videos": expected,
                "telemetry": expected_telemetry,
                "expected_videos": expected,
                "expected_telemetry": expected_telemetry,
                "expected_contact_sheets": expected_contact_sheets,
                "missing_videos": [],
                "missing_telemetry": [],
                "combined_video": f"{profile}_combined_actions.mp4" if combined else None,
                "combined_present": combined,
                "exit_code": 0,
                "ok": True,
            }
        )
        for name in expected:
            _write_video(root / profile / name)
        for name in expected_telemetry:
            _write_telemetry(root / profile / name)
    (root / "manifest.json").write_text(
        json.dumps(
            {
                "ok": True,
                "commands": commands,
                "production_command_coverage": record_agent_videos.production_command_coverage(
                    commands
                ),
                "record_combined": combined,
                "profiles": entries,
            }
        )
    )


def test_viewer_command_can_request_combined_recording(tmp_path: Path) -> None:
    cmd = record_agent_videos._viewer_cmd(
        "unitree-g1",
        ["stand up", "walk forward"],
        tmp_path,
        2,
        320,
        240,
        None,
        True,
    )
    assert "--record-combined" in cmd


def test_viewer_command_can_forward_policy_checkpoint(tmp_path: Path) -> None:
    checkpoint = tmp_path / "ckpt"
    cmd = record_agent_videos._viewer_cmd(
        "unitree-g1",
        ["walk forward"],
        tmp_path,
        2,
        320,
        240,
        None,
        True,
        checkpoint,
    )
    assert cmd[-2:] == ["--policy-checkpoint", str(checkpoint)]


def test_viewer_command_can_preserve_state_between_commands(tmp_path: Path) -> None:
    cmd = record_agent_videos._viewer_cmd(
        "unitree-g1",
        ["walk forward"],
        tmp_path,
        2,
        320,
        240,
        None,
        True,
        preserve_state_between_commands=True,
    )
    assert "--preserve-state-between-commands" in cmd


def test_video_evidence_requires_combined_videos(tmp_path: Path) -> None:
    profiles = ["unitree-g1"]
    commands = ["stand up", "walk forward"]
    _write_manifest(tmp_path, profiles, commands, combined=False)
    result = _check_video_evidence(
        tmp_path,
        profiles=profiles,
        commands=commands,
        min_video_bytes=1024,
        require_combined=True,
    )
    assert result["ok"] is False
    assert result["profiles"][0]["missing"] == ["unitree-g1_combined_actions.mp4"]


def test_video_evidence_accepts_per_action_and_combined(tmp_path: Path) -> None:
    profiles = ["unitree-g1", "unitree-h1"]
    commands = ["stand up", "turn left"]
    _write_manifest(tmp_path, profiles, commands, combined=True)
    result = _check_video_evidence(
        tmp_path,
        profiles=profiles,
        commands=commands,
        min_video_bytes=1024,
        require_combined=True,
    )
    assert result["ok"] is True
    assert result["commands_match"] is True
    assert result["combined_recording_match"] is True


def test_video_evidence_rejects_manifest_command_mismatch(tmp_path: Path) -> None:
    profiles = ["unitree-g1"]
    _write_manifest(tmp_path, profiles, ["stand up", "turn left"], combined=True)
    result = _check_video_evidence(
        tmp_path,
        profiles=profiles,
        commands=["stand up", "walk forward"],
        min_video_bytes=1024,
        require_combined=True,
    )

    assert result["ok"] is False
    assert result["commands_match"] is False


def test_video_evidence_rejects_manifest_combined_flag_mismatch(tmp_path: Path) -> None:
    profiles = ["unitree-g1"]
    commands = ["stand up", "turn left"]
    _write_manifest(tmp_path, profiles, commands, combined=True)
    manifest = json.loads((tmp_path / "manifest.json").read_text())
    manifest["record_combined"] = False
    (tmp_path / "manifest.json").write_text(json.dumps(manifest))

    result = _check_video_evidence(
        tmp_path,
        profiles=profiles,
        commands=commands,
        min_video_bytes=1024,
        require_combined=True,
    )

    assert result["ok"] is False
    assert result["combined_recording_match"] is False


def test_video_evidence_survives_later_single_profile_manifest(tmp_path: Path) -> None:
    commands = ["stand up", "turn left"]
    _write_manifest(tmp_path, ["unitree-g1", "unitree-h1"], commands, combined=True)
    manifest = json.loads((tmp_path / "manifest.json").read_text())
    manifest["profiles"] = [manifest["profiles"][0]]
    manifest["policy_checkpoint"] = "/tmp/checkpoints/unitree_g1_alberta_full"
    (tmp_path / "manifest.json").write_text(json.dumps(manifest))

    result = _check_video_evidence(
        tmp_path,
        profiles=["unitree-g1", "unitree-h1"],
        commands=commands,
        min_video_bytes=1024,
        require_combined=True,
    )

    assert result["ok"] is True
    assert result["profiles"][1]["manifest_entry"] is False
    assert result["profiles"][1]["ok"] is True


def test_validator_can_run_with_mocked_non_video_checks(monkeypatch, tmp_path: Path) -> None:
    profiles = ["unitree-g1"]
    commands = ["stand up"]
    _write_manifest(tmp_path, profiles, commands, combined=True)
    monkeypatch.setattr(
        "scripts.validate_multi_robot_training_readiness._check_profile",
        lambda profile_id, *, pca_dim: {"ok": True, "profile": profile_id},
    )
    monkeypatch.setattr(
        "scripts.validate_multi_robot_training_readiness._check_alberta",
        lambda: {"ok": True},
    )
    result = validate(
        profiles=profiles,
        commands=commands,
        video_evidence=tmp_path,
        pca_dim=32,
        min_video_bytes=1024,
        require_combined_videos=True,
    )
    assert result["ok"] is True


def test_default_profiles_include_unitree_r1() -> None:
    assert "unitree-r1" in DEFAULT_PROFILES


def test_default_commands_cover_full_production_curriculum() -> None:
    assert DEFAULT_COMMANDS == (
        "stand up",
        "walk forward",
        "walk backward",
        "sidestep left",
        "sidestep right",
        "turn left",
        "turn right",
    )
    assert record_agent_videos.PRODUCTION_REQUIRED_COMMANDS == DEFAULT_COMMANDS


def test_record_agent_videos_expected_contact_sheets_cover_all_commands() -> None:
    names = record_agent_videos.expected_contact_sheet_names(
        "asimov-1",
        list(record_agent_videos.PRODUCTION_REQUIRED_COMMANDS),
        record_combined=True,
    )

    assert names == [
        "asimov-1_asimov-1_stand_up_contact.jpg",
        "asimov-1_asimov-1_walk_forward_contact.jpg",
        "asimov-1_asimov-1_walk_backward_contact.jpg",
        "asimov-1_asimov-1_sidestep_left_contact.jpg",
        "asimov-1_asimov-1_sidestep_right_contact.jpg",
        "asimov-1_asimov-1_turn_left_contact.jpg",
        "asimov-1_asimov-1_turn_right_contact.jpg",
        "asimov-1_asimov-1_combined_actions_contact.jpg",
    ]


def test_record_agent_videos_rejects_incomplete_checkpoint_command_set(tmp_path: Path) -> None:
    with pytest.raises(SystemExit) as excinfo:
        record_agent_videos.main(
            [
                "--profiles",
                "asimov-1",
                "--commands",
                "stand up",
                "walk forward",
                "turn left",
                "turn right",
                "--out",
                str(tmp_path),
                "--max-steps",
                "1",
                "--policy-checkpoint",
                str(tmp_path / "checkpoint"),
            ]
        )

    assert excinfo.value.code == 2
    assert not (tmp_path / "manifest.json").exists()


def test_record_agent_videos_preserves_existing_profile_manifest_entries(
    monkeypatch,
    tmp_path: Path,
) -> None:
    commands = list(record_agent_videos.PRODUCTION_REQUIRED_COMMANDS)
    old_expected = record_agent_videos.expected_video_names(
        "unitree-g1",
        commands,
        record_combined=True,
    )
    for name in old_expected:
        _write_video(tmp_path / "unitree-g1" / name)
    for name in record_agent_videos.expected_telemetry_names(
        "unitree-g1",
        commands,
        record_combined=True,
    ):
        _write_telemetry(tmp_path / "unitree-g1" / name)

    def fake_run(cmd, **_kwargs):
        profile = cmd[cmd.index("--profile") + 1]
        out_dir = Path(cmd[cmd.index("--record") + 1])
        expected = record_agent_videos.expected_video_names(
            profile,
            commands,
            record_combined=True,
        )
        for name in expected:
            _write_video(out_dir / name)
        for name in record_agent_videos.expected_telemetry_names(
            profile,
            commands,
            record_combined=True,
        ):
            _write_telemetry(out_dir / name)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(record_agent_videos.subprocess, "run", fake_run)

    rc = record_agent_videos.main(
        [
            "--profiles",
            "unitree-r1",
            "--commands",
            *commands,
            "--out",
            str(tmp_path),
            "--max-steps",
            "1",
            "--scripted-smoke",
            "--allow-existing-files",
        ]
    )

    assert rc == 0
    manifest = json.loads((tmp_path / "manifest.json").read_text())
    entries = {entry["profile"]: entry for entry in manifest["profiles"]}
    assert entries["unitree-r1"]["ok"] is True
    assert entries["unitree-g1"]["manifest_source"] == "existing_files"


def test_record_agent_videos_preserves_existing_entries_with_policy_checkpoint(
    monkeypatch,
    tmp_path: Path,
) -> None:
    commands = list(record_agent_videos.PRODUCTION_REQUIRED_COMMANDS)
    old_expected = record_agent_videos.expected_video_names(
        "unitree-g1",
        commands,
        record_combined=True,
    )
    for name in old_expected:
        _write_video(tmp_path / "unitree-g1" / name)
    for name in record_agent_videos.expected_telemetry_names(
        "unitree-g1",
        commands,
        record_combined=True,
    ):
        _write_telemetry(tmp_path / "unitree-g1" / name)
    checkpoint = tmp_path / "checkpoints" / "asimov_1_alberta_full"
    old_checkpoint = tmp_path / "checkpoints" / "unitree_g1_alberta_full"
    (tmp_path / "manifest.json").write_text(
        json.dumps(
            {
                "profiles": [
                    {
                        "profile": "unitree-g1",
                        "policy_checkpoint": str(old_checkpoint.resolve()),
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, **_kwargs):
        profile = cmd[cmd.index("--profile") + 1]
        out_dir = Path(cmd[cmd.index("--record") + 1])
        expected = record_agent_videos.expected_video_names(
            profile,
            commands,
            record_combined=True,
        )
        for name in expected:
            _write_video(out_dir / name)
        for name in record_agent_videos.expected_telemetry_names(
            profile,
            commands,
            record_combined=True,
        ):
            _write_telemetry(out_dir / name)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(record_agent_videos.subprocess, "run", fake_run)

    rc = record_agent_videos.main(
        [
            "--profiles",
            "asimov-1",
            "--commands",
            *commands,
            "--out",
            str(tmp_path),
            "--max-steps",
            "1",
            "--policy-checkpoint",
            str(checkpoint),
            "--allow-existing-files",
        ]
    )

    assert rc == 0
    manifest = json.loads((tmp_path / "manifest.json").read_text())
    entries = {entry["profile"]: entry for entry in manifest["profiles"]}
    assert manifest["policy_checkpoint"] == str(checkpoint.resolve())
    assert manifest["production_command_coverage"]["ok"] is True
    assert manifest["production_command_coverage"]["missing"] == []
    assert entries["asimov-1"]["policy_checkpoint"] == str(checkpoint.resolve())
    assert entries["asimov-1"]["expected_telemetry"] == record_agent_videos.expected_telemetry_names(
        "asimov-1",
        commands,
        record_combined=True,
    )
    assert entries["asimov-1"]["expected_contact_sheets"] == record_agent_videos.expected_contact_sheet_names(
        "asimov-1",
        commands,
        record_combined=True,
    )
    assert entries["unitree-g1"]["manifest_source"] == "existing_files"
    assert entries["unitree-g1"]["policy_checkpoint"] == str(old_checkpoint.resolve())


def test_video_evidence_accepts_existing_file_manifest_entries(tmp_path: Path) -> None:
    commands = ["stand up", "turn left"]
    _write_manifest(tmp_path, ["unitree-g1"], commands, combined=True)
    manifest = json.loads((tmp_path / "manifest.json").read_text())
    manifest["profiles"][0]["exit_code"] = None
    manifest["profiles"][0]["manifest_source"] = "existing_files"
    (tmp_path / "manifest.json").write_text(json.dumps(manifest))

    result = _check_video_evidence(
        tmp_path,
        profiles=["unitree-g1"],
        commands=commands,
        min_video_bytes=1024,
        require_combined=True,
    )

    assert result["ok"] is True


def test_manifest_entry_exit_requires_clean_exit_or_existing_file_source() -> None:
    assert _manifest_entry_exit_ok({}) is True
    assert _manifest_entry_exit_ok({"exit_code": 0}) is True
    assert _manifest_entry_exit_ok({"exit_code": None}) is False
    assert (
        _manifest_entry_exit_ok(
            {"exit_code": None, "manifest_source": "existing_files", "ok": True}
        )
        is True
    )
