"""ASIMOV-1 text-conditioned MJX/Brax training entrypoint."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.constants import ASIMOV1_GENERATED_MJCF


def make_asimov_text_conditioned_mjx_env(**_kwargs):
    class FakeAsimovMJX:
        observation_size = 77
        proprio_dim = 45
        text_dim = 32
        action_size = 12
        active_tasks = ("stand_up", "walk_forward", "walk_backward", "sidestep_left", "sidestep_right", "turn_left", "turn_right")

        class _Config:
            episode_length = 500

        _config = _Config()

        @property
        def mj_model(self):
            import mujoco

            return mujoco.MjModel.from_xml_path(str(ASIMOV1_GENERATED_MJCF))

    return FakeAsimovMJX()


def train_from_job(job_dir: str | Path) -> dict[str, Any]:
    job_dir = Path(job_dir)
    job = json.loads((job_dir / "training_job.json").read_text(encoding="utf-8"))
    manifest = dict(job["manifest_template"])
    start = time.time()
    (job_dir / "policy_brax.pkl").write_bytes(b"placeholder-asimov-brax-policy")
    manifest.update(
        {
            "regime": "brax_ppo",
            "profile_id": "asimov-1",
            "ckpt": "policy_brax.pkl",
            "obs_dim": int(manifest["proprio_dim"] + manifest["text_dim"]),
            "action_dim": 12,
            "output_dim": 25,
            "wall_clock_s": round(time.time() - start, 3),
        }
    )
    (job_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (job_dir / "metrics.json").write_text(json.dumps([{"steps": 0, "reward": 0.0}], indent=2) + "\n")
    (job_dir / "config.json").write_text(json.dumps({"job": job["job"], "mjcf_xml": str(ASIMOV1_GENERATED_MJCF)}, indent=2) + "\n")
    return {"ok": True, "job_dir": str(job_dir), "policy": str(job_dir / "policy_brax.pkl")}
