"""Smoke test the unified training CLI dry-run mode for every profile.

These tests don't run the full PPO loop (too expensive for CI); they
exercise the `--dry-run` mode that reset+step the env once and writes a
manifest. That's enough to catch broken profile→env wiring before a GPU
spend.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

from eliza_robot.profiles.schema import load_profile
from eliza_robot.rl.text_conditioned import train as module_train_cli
from scripts import train_text_conditioned as train_cli

PKG_ROOT = Path(__file__).resolve().parents[2]
TRAIN_SCRIPT = PKG_ROOT / "scripts" / "train_text_conditioned.py"
MODULE_TRAIN = "eliza_robot.rl.text_conditioned.train"

SUPPORTED = ("hiwonder-ainex", "asimov-1", "unitree-g1", "unitree-h1", "unitree-r1")


@pytest.mark.parametrize("profile_id", SUPPORTED)
def test_unified_train_cli_dry_run_writes_manifest(
    profile_id: str, tmp_path: Path
) -> None:
    pytest.importorskip("mujoco")
    out_dir = tmp_path / f"smoke_{profile_id}"
    cmd = [
        sys.executable,
        str(TRAIN_SCRIPT),
        "--profile",
        profile_id,
        "--out",
        str(out_dir),
        "--dry-run",
        "--seed",
        "0",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=str(PKG_ROOT))
    assert proc.returncode == 0, (
        f"{profile_id} dry-run rc={proc.returncode}\n"
        f"stdout={proc.stdout[-500:]}\nstderr={proc.stderr[-500:]}"
    )
    manifest_path = out_dir / "manifest.json"
    assert manifest_path.is_file(), f"missing manifest at {manifest_path}"
    manifest = json.loads(manifest_path.read_text())
    assert manifest["regime"] == "dry_run"
    assert manifest["profile_id"] == profile_id
    assert manifest["dry_run"] is True
    assert manifest["default_backend"] == "alberta"
    assert manifest["obs_dim"] > 0
    assert manifest["action_dim"] > 0
    assert manifest["output_dim"] == len(load_profile(profile_id).kinematics.joints)
    assert manifest["output_dim"] >= manifest["action_dim"]


def test_unified_train_cli_help_advertises_alberta_default() -> None:
    proc = subprocess.run(
        [sys.executable, str(TRAIN_SCRIPT), "--help"],
        capture_output=True,
        text=True,
        cwd=str(PKG_ROOT),
    )
    assert proc.returncode == 0
    help_text = proc.stdout + proc.stderr
    assert "--backend" in help_text
    assert "alberta" in help_text.lower()
    assert "default" in help_text.lower()
    help_lower = help_text.lower()
    assert "total env-step budget" in help_lower


def test_robot_package_metadata_exposes_installable_training_clis() -> None:
    pyproject = tomllib.loads((PKG_ROOT / "pyproject.toml").read_text())

    assert pyproject["tool"]["uv"]["package"] is True
    scripts = pyproject["project"]["scripts"]
    assert scripts["eliza-robot-train"] == "eliza_robot.rl.text_conditioned.train:main"
    assert scripts["eliza-robot-train-alberta"] == "eliza_robot.rl.alberta.train_robot:main"
    assert scripts["eliza-robot-benchmark-alberta"] == "eliza_robot.rl.alberta.benchmark:main"
    assert scripts["eliza-robot-compare-backends"] == "scripts.compare_text_conditioned_backends:main"
    assert (
        scripts["eliza-robot-validate-alberta-benchmark"]
        == "scripts.validate_alberta_benchmark_artifacts:main"
    )
    assert (
        scripts["eliza-robot-prepare-full-training"]
        == "scripts.prepare_end_to_end_full_training:main"
    )
    assert (
        scripts["eliza-robot-run-full-training-bundle"]
        == "scripts.run_end_to_end_full_training_bundle:main"
    )
    assert (
        scripts["eliza-robot-validate-alberta-checkpoint"]
        == "scripts.validate_alberta_robot_checkpoint:main"
    )
    assert (
        scripts["eliza-robot-validate-alberta-vendoring"]
        == "scripts.validate_alberta_vendoring:main"
    )
    assert (
        scripts["eliza-robot-validate-asimov1-production-checkpoint"]
        == "scripts.validate_asimov1_production_checkpoint:main"
    )
    assert (
        scripts["eliza-robot-validate-training-inputs"]
        == "scripts.validate_robot_training_inputs:main"
    )
    assert (
        scripts["eliza-robot-validate-nebius-instance-launch"]
        == "scripts.validate_nebius_instance_launch_hygiene:main"
    )
    package_find = pyproject["tool"]["setuptools"]["packages"]["find"]
    assert "eliza_robot*" in package_find["include"]
    assert "scripts*" in package_find["include"]


def test_unified_train_alberta_splits_total_steps_across_tasks(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    import eliza_robot.rl.alberta.train_robot as train_robot_mod

    captured: dict[str, object] = {}

    def fake_train_robot(
        profile_id,
        tasks,
        steps_per_task,
        out_dir,
        *,
        pca_dim,
            episode_steps,
            action_scale,
            action_scale_initial,
            action_scale_increment,
            eval_episodes,
            seed,
        requested_total_steps=None,
        domain_rand=True,
    ):
        captured.update(
            {
                "profile_id": profile_id,
                "tasks": tasks,
                "steps_per_task": steps_per_task,
                "out_dir": out_dir,
                "pca_dim": pca_dim,
                "episode_steps": episode_steps,
                "action_scale": action_scale,
                "action_scale_initial": action_scale_initial,
                "action_scale_increment": action_scale_increment,
                "eval_episodes": eval_episodes,
                "seed": seed,
                "requested_total_steps": requested_total_steps,
                "domain_rand": domain_rand,
            }
        )
        return {"regime": "alberta_streaming"}

    monkeypatch.setattr(train_robot_mod, "train_robot", fake_train_robot)
    manifest = train_cli._train_alberta(
        "hiwonder-ainex",
        tmp_path,
        total_steps=10,
        seed=7,
        include_tasks=("stand_up", "walk_forward", "turn_left"),
        pca_dim=16,
        episode_steps=11,
        action_scale=0.3,
        action_scale_initial=0.15,
        action_scale_increment=0.05,
        eval_episodes=2,
        domain_rand=False,
    )

    assert manifest["regime"] == "alberta_streaming"
    assert captured["steps_per_task"] == 4
    assert captured["requested_total_steps"] == 10
    assert captured["episode_steps"] == 11
    assert captured["action_scale"] == 0.3
    assert captured["action_scale_initial"] == 0.15
    assert captured["action_scale_increment"] == 0.05
    assert captured["eval_episodes"] == 2
    assert captured["domain_rand"] is False
    assert captured["tasks"] == ["stand_up", "walk_forward", "turn_left"]


@pytest.mark.parametrize("profile_id", SUPPORTED)
def test_module_train_dry_run_uses_profile_env_and_alberta_default(
    profile_id: str, tmp_path: Path
) -> None:
    pytest.importorskip("mujoco")
    out_dir = tmp_path / f"module_{profile_id}"
    proc = subprocess.run(
        [
            sys.executable,
            "-m",
            MODULE_TRAIN,
            "--profile",
            profile_id,
            "--out",
            str(out_dir),
            "--dry-run",
            "--seed",
            "0",
        ],
        capture_output=True,
        text=True,
        cwd=str(PKG_ROOT),
    )
    assert proc.returncode == 0, (
        f"{profile_id} module dry-run rc={proc.returncode}\n"
        f"stdout={proc.stdout[-500:]}\nstderr={proc.stderr[-500:]}"
    )
    manifest = json.loads((out_dir / "manifest.json").read_text())
    assert manifest["regime"] == "dry_run"
    assert manifest["profile_id"] == profile_id
    assert manifest["default_backend"] == "alberta"
    assert manifest["output_dim"] == len(load_profile(profile_id).kinematics.joints)
    assert manifest["output_dim"] >= manifest["action_dim"]


def test_module_train_uses_mode_specific_default_outputs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Path] = {}

    def fake_dry_run(out_dir, profile_id, seed):
        captured["dry_run"] = out_dir
        return {}

    def fake_smoke(out_dir, profile_id, total_steps, *, seed, tasks, pca_dim, domain_rand):
        captured["smoke"] = out_dir
        return {}

    def fake_full(
        out_dir,
        profile_id,
        *,
        total_steps,
        num_envs,
        num_evals,
        seed,
        learning_rate,
        domain_rand,
    ):
        captured["full"] = out_dir
        return {}

    def fake_alberta(
        out_dir,
        profile_id,
        *,
        total_steps,
        seed,
        tasks,
        pca_dim,
        episode_steps,
        eval_episodes,
        domain_rand,
        action_scale,
        action_scale_initial,
        action_scale_increment,
        gamma,
        normalize,
        require_phase_success,
        min_phase_success_rate,
        phase_eval_interval_steps,
    ):
        captured["alberta"] = out_dir
        captured["alberta_gamma"] = gamma
        captured["alberta_normalize"] = normalize
        return {}

    monkeypatch.setattr(module_train_cli, "_write_manifest_dry_run", fake_dry_run)
    monkeypatch.setattr(module_train_cli, "_train_smoke", fake_smoke)
    monkeypatch.setattr(module_train_cli, "_write_full_training_job", fake_full)
    monkeypatch.setattr(module_train_cli, "_train_alberta", fake_alberta)

    assert module_train_cli.main(["--dry-run"]) == 0
    assert module_train_cli.main(["--smoke", "--steps", "1"]) == 0
    assert module_train_cli.main(["--full", "--steps", "1"]) == 0
    assert module_train_cli.main(["--steps", "1"]) == 0

    assert captured["dry_run"].name == "text_conditioned_dry_run"
    assert captured["smoke"].name == "text_conditioned_smoke"
    assert captured["full"].name == "asimov_1_brax_mjx_baseline"
    assert captured["alberta"].name == "alberta_text_conditioned"
    assert captured["alberta_gamma"] == 0.97
    assert captured["alberta_normalize"] is True
    assert captured["smoke"] != captured["alberta"]
    assert captured["full"] != captured["alberta"]
    assert captured["dry_run"] != captured["alberta"]


def test_unified_train_cli_rejects_unknown_profile() -> None:
    cmd = [
        sys.executable,
        str(TRAIN_SCRIPT),
        "--profile",
        "does-not-exist",
        "--dry-run",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=str(PKG_ROOT))
    assert proc.returncode != 0
    assert "invalid choice" in (proc.stderr + proc.stdout).lower()
