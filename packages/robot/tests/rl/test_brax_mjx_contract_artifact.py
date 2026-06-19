from __future__ import annotations

from pathlib import Path

from scripts.generate_brax_mjx_contract_artifact import generate_contract_artifact


def test_generate_brax_mjx_contract_artifact_writes_local_baseline_contract(
    tmp_path: Path,
) -> None:
    report = generate_contract_artifact(
        tmp_path,
        steps=8,
        num_envs=2,
        seed=11,
        pca_dim=6,
    )

    assert report["ok"] is True
    assert report["contract_only"] is True
    assert report["production_training"] is False
    assert report["manifest"]["regime"] == "brax_ppo"
    assert report["manifest"]["profile_id"] == "asimov-1"
    assert report["manifest"]["policy_obs_key"] == "state"
    assert report["manifest"]["value_obs_key"] == "privileged_state"
    assert report["checks"]["asymmetric_actor_critic"] is True
    assert (tmp_path / "policy_brax.pkl").is_file()
    assert (tmp_path / "validation_report.json").is_file()
