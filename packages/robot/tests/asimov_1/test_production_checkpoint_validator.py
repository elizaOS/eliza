# ruff: noqa: E402,I001

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import validate_asimov1_production_checkpoint as validator  # noqa: E402


TASKS = [
    "stand_up",
    "walk_forward",
    "walk_backward",
    "sidestep_left",
    "sidestep_right",
    "turn_left",
    "turn_right",
]


def _write_checkpoint(path: Path, *, steps: int = 2_000_000, tiny: bool = False) -> None:
    path.mkdir(parents=True, exist_ok=True)
    manifest = {
        "regime": "brax_ppo",
        "curriculum_version": 1,
        "pca_dim": 8,
        "active_tasks": TASKS,
        "obs_dim": 53,
        "proprio_dim": 45,
        "text_dim": 8,
        "action_dim": 12,
        "output_dim": 25,
        "profile_id": "asimov-1",
        "ckpt": "policy_brax.pkl",
    }
    if tiny:
        manifest["tiny_training_validation"] = True
    (path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (path / "metrics.json").write_text(
        json.dumps([{"steps": steps, "reward": 1.25, "elapsed_s": 12.0}]),
        encoding="utf-8",
    )
    (path / "config.json").write_text(
        json.dumps({"profile_id": "asimov-1", "active_tasks": TASKS}),
        encoding="utf-8",
    )
    (path / "policy_brax.pkl").write_bytes(b"not-empty")


def test_production_checkpoint_validator_accepts_complete_artifact(tmp_path: Path) -> None:
    _write_checkpoint(tmp_path)

    report = validator.validate_asimov1_production_checkpoint(tmp_path, min_steps=1_000_000)

    assert report["ok"] is True
    assert all(report["checks"].values())
    assert report["max_metric_steps"] == 2_000_000


def test_production_checkpoint_validator_rejects_tiny_or_undertrained_checkpoint(
    tmp_path: Path,
) -> None:
    _write_checkpoint(tmp_path, steps=8, tiny=True)

    report = validator.validate_asimov1_production_checkpoint(tmp_path, min_steps=1_000_000)

    assert report["ok"] is False
    assert report["checks"]["not_tiny_validation"] is False
    assert report["checks"]["metrics_steps"] is False


def test_production_checkpoint_validator_cli(tmp_path: Path) -> None:
    _write_checkpoint(tmp_path, steps=128)

    proc = subprocess.run(
        [
            sys.executable,
            "packages/robot/scripts/validate_asimov1_production_checkpoint.py",
            str(tmp_path),
            "--min-steps",
            "128",
        ],
        cwd=Path(__file__).resolve().parents[4],
        text=True,
        capture_output=True,
        check=False,
    )

    assert proc.returncode == 0
    assert json.loads(proc.stdout)["ok"] is True
