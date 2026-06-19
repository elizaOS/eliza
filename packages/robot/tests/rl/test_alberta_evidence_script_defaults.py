from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts import (
    evidence_final_e2e,
    evidence_state_mirror_e2e,
    evidence_text_to_action_calibrated_e2e,
    evidence_vlm_evaluation_e2e,
    interactive_viewer,
    sim_validation_gate,
)


def _write_manifest(path: Path, *, profile_id: str) -> None:
    path.mkdir(parents=True, exist_ok=True)
    (path / "manifest.json").write_text(
        json.dumps({"profile_id": profile_id, "regime": "alberta_streaming"}),
        encoding="utf-8",
    )


@pytest.mark.parametrize(
    "module",
    [
        evidence_final_e2e,
        evidence_state_mirror_e2e,
        evidence_text_to_action_calibrated_e2e,
        evidence_vlm_evaluation_e2e,
    ],
)
def test_legacy_evidence_scripts_default_to_alberta_checkpoint(module) -> None:
    assert module.DEFAULT_ALBERTA_CHECKPOINT.name == "alberta_text_conditioned"
    assert module.DEFAULT_ALBERTA_CHECKPOINT.parent.name == "checkpoints"
    assert module.DEFAULT_ALBERTA_CHECKPOINT.parents[1].name == "robot"


@pytest.mark.parametrize(
    "module",
    [
        evidence_final_e2e,
        evidence_state_mirror_e2e,
        evidence_text_to_action_calibrated_e2e,
        evidence_vlm_evaluation_e2e,
    ],
)
def test_legacy_evidence_scripts_reject_profile_mismatch(
    tmp_path: Path,
    module,
) -> None:
    _write_manifest(tmp_path, profile_id="asimov-1")

    with pytest.raises(ValueError, match="checkpoint profile mismatch"):
        module._validate_checkpoint_profile(tmp_path)


@pytest.mark.parametrize(
    "module",
    [
        evidence_final_e2e,
        evidence_state_mirror_e2e,
        evidence_text_to_action_calibrated_e2e,
        evidence_vlm_evaluation_e2e,
    ],
)
def test_legacy_evidence_scripts_accept_hiwonder_alberta_checkpoint(
    tmp_path: Path,
    module,
) -> None:
    _write_manifest(tmp_path, profile_id="hiwonder-ainex")

    manifest = module._validate_checkpoint_profile(tmp_path)

    assert manifest["regime"] == "alberta_streaming"


def test_sim_validation_gate_defaults_to_alberta_checkpoint() -> None:
    assert sim_validation_gate.DEFAULT_ALBERTA_CHECKPOINT.name == "alberta_text_conditioned"
    assert sim_validation_gate.DEFAULT_ALBERTA_CHECKPOINT.parent.name == "checkpoints"
    assert sim_validation_gate.DEFAULT_ALBERTA_CHECKPOINT.parents[1].name == "robot"


def test_interactive_viewer_resolves_matching_alberta_checkpoint_by_default(
    tmp_path: Path,
) -> None:
    profile_checkpoint = tmp_path / "checkpoints" / "unitree_g1_alberta_full"
    generic_checkpoint = tmp_path / "checkpoints" / "alberta_text_conditioned"
    _write_manifest(profile_checkpoint, profile_id="unitree-g1")
    _write_manifest(generic_checkpoint, profile_id="hiwonder-ainex")

    resolved = interactive_viewer._resolve_default_policy_checkpoint(
        "unitree-g1",
        root=tmp_path,
    )

    assert resolved == profile_checkpoint


def test_interactive_viewer_skips_alberta_checkpoint_profile_mismatch(
    tmp_path: Path,
) -> None:
    _write_manifest(
        tmp_path / "checkpoints" / "alberta_text_conditioned",
        profile_id="hiwonder-ainex",
    )

    resolved = interactive_viewer._resolve_default_policy_checkpoint(
        "unitree-g1",
        root=tmp_path,
    )

    assert resolved is None
