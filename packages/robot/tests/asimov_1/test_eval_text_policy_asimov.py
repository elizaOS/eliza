from __future__ import annotations

import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import eval_text_policy  # noqa: E402


class _FakeAsimovEnv:
    active_tasks = ("stand_up", "walk_forward")
    action_size = 12
    observation_size = {"state": 77, "privileged_state": 86}
    actor_observation_size = 77
    privileged_observation_size = 86
    proprio_dim = 45
    text_dim = 32
    mj_model = SimpleNamespace(nu=25)


def test_asimov_auto_eval_uses_mjx_backend_report_contract(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def fake_make_env(**kwargs):
        captured["env_kwargs"] = kwargs
        return _FakeAsimovEnv()

    fake_module = ModuleType("eliza_robot.sim.mujoco.asimov_mjx_training")
    fake_module.DEFAULT_ACTIVE_TASKS = ("stand_up", "walk_forward", "turn_left")
    fake_module.make_asimov_text_conditioned_mjx_env = fake_make_env
    monkeypatch.setitem(
        sys.modules,
        "eliza_robot.sim.mujoco.asimov_mjx_training",
        fake_module,
    )
    monkeypatch.setattr(
        eval_text_policy,
        "_roll_one_asimov_mjx",
        lambda _env, _policy, task_id, **_kwargs: (1.25 if task_id == "stand_up" else 2.5, 3),
    )

    report = eval_text_policy.evaluate(
        "asimov-1",
        tasks=("stand_up", "walk_forward"),
        episodes=1,
        max_steps=3,
        untrained=True,
        backend="auto",
    )

    assert captured["env_kwargs"] == {
        "active_tasks": ("stand_up", "walk_forward"),
        "pca_dim": 32,
        "episode_length": 3,
        "domain_randomization": {},
    }
    assert report["profile_id"] == "asimov-1"
    assert report["env"] == "asimov_mjx"
    assert report["policy"] == "untrained_zero"
    assert report["env_action_dim"] == 12
    assert report["env_observation_dim"] == 77
    assert report["env_critic_observation_dim"] == 86
    assert report["env_observation_keys"] == ["privileged_state", "state"]
    assert report["env_proprio_dim"] == 45
    assert report["env_text_dim"] == 32
    assert report["mujoco_actuators"] == 25
    assert report["tasks"]["stand_up"]["mean_reward"] == 1.25
    assert report["tasks"]["walk_forward"]["mean_reward"] == 2.5
    assert report["mean_reward_overall"] == 1.875


def test_mjx_eval_rejects_non_asimov_profile() -> None:
    try:
        eval_text_policy.evaluate(
            "unitree-g1",
            tasks=("walk_forward",),
            episodes=1,
            max_steps=1,
            untrained=True,
            backend="mjx",
        )
    except ValueError as exc:
        assert "asimov-1" in str(exc)
    else:
        raise AssertionError("expected --backend mjx to reject non-ASIMOV profiles")


def test_profile_eval_requires_checkpoint_unless_untrained(tmp_path: Path) -> None:
    try:
        eval_text_policy.evaluate(
            "hiwonder-ainex",
            tasks=("walk_forward",),
            episodes=1,
            max_steps=1,
            untrained=False,
            ckpt=tmp_path / "missing",
            backend="profile",
        )
    except FileNotFoundError as exc:
        assert "manifest.json" in str(exc)
    else:
        raise AssertionError("expected missing trained checkpoint to fail")


def test_eval_default_checkpoint_is_alberta_default() -> None:
    checkpoint = eval_text_policy._default_checkpoint("hiwonder-ainex")

    assert checkpoint.name == "alberta_text_conditioned"
    assert checkpoint.parent.name == "checkpoints"


def test_profile_eval_rejects_checkpoint_profile_mismatch(monkeypatch, tmp_path: Path) -> None:
    class _FakePolicy:
        manifest = SimpleNamespace(
            profile_id="unitree-g1",
            output_dim=29,
            action_dim=12,
            regime="alberta_streaming",
            proprio_dim=45,
            obs_dim=77,
            pca_dim=32,
        )

    monkeypatch.setattr(eval_text_policy, "_load_policy", lambda _ckpt: _FakePolicy())

    try:
        eval_text_policy.evaluate(
            "hiwonder-ainex",
            tasks=("walk_forward",),
            episodes=1,
            max_steps=1,
            untrained=False,
            ckpt=tmp_path,
            backend="profile",
        )
    except ValueError as exc:
        assert "checkpoint profile mismatch" in str(exc)
    else:
        raise AssertionError("expected mismatched checkpoint profile to fail")


def test_profile_eval_rejects_checkpoint_output_dim_mismatch(
    monkeypatch,
    tmp_path: Path,
) -> None:
    class _FakePolicy:
        manifest = SimpleNamespace(
            profile_id="hiwonder-ainex",
            output_dim=29,
            action_dim=12,
            regime="alberta_streaming",
            proprio_dim=45,
            obs_dim=77,
            pca_dim=32,
        )

    monkeypatch.setattr(eval_text_policy, "_load_policy", lambda _ckpt: _FakePolicy())

    try:
        eval_text_policy.evaluate(
            "hiwonder-ainex",
            tasks=("walk_forward",),
            episodes=1,
            max_steps=1,
            untrained=False,
            ckpt=tmp_path,
            backend="profile",
        )
    except ValueError as exc:
        assert "checkpoint output_dim mismatch" in str(exc)
    else:
        raise AssertionError("expected mismatched checkpoint output_dim to fail")
