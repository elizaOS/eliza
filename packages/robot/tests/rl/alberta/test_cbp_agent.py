"""Contract tests for the nonlinear Stream-AC(lambda) + Continual Backprop controller.

These guard the functional claims the nonlinear continual path stands on:

1. The MLP actor-critic actually learns a single reach task online (without this,
   continual metrics are meaningless).
2. The plain Stream-AC core learns with CBP disabled (the AC update is sound
   independently of generate-and-test).
3. Continual Backprop actually replaces hidden units (the plasticity mechanism
   fires) when enabled, and never replaces them when disabled.
4. ``state_dict`` round-trips the learned policy exactly.

Kept small enough to run on CPU in a few seconds.
"""

from __future__ import annotations

import os

os.environ.setdefault("JAX_PLATFORMS", "cpu")

import numpy as np
from alberta_framework.core.continual_backprop import ContinualBackpropConfig

from eliza_robot.rl.alberta.cbp_agent import (
    AlbertaCBPController,
    CBPControllerConfig,
    RetentionConfig,
)
from eliza_robot.rl.alberta.continual_env import JointReachConfig, JointReachEnv
from eliza_robot.rl.alberta.loop import evaluate, train_online


def _controller(env: JointReachEnv, *, cbp_enabled: bool = True, **cbp_kwargs) -> AlbertaCBPController:
    return AlbertaCBPController(
        CBPControllerConfig(
            obs_dim=int(env.observation_space.shape[0]),
            action_dim=int(env.action_space.shape[0]),
            hidden_sizes=(32,),
            gamma=0.5,
            actor_step_size=1e-2,
            critic_step_size=2e-2,
            actor_lamda=0.7,
            critic_lamda=0.7,
            log_sigma_init=-1.0,
            normalize=True,
            obgd_kappa=2.0,
            cbp=ContinualBackpropConfig(enabled=cbp_enabled, **cbp_kwargs),
            seed=0,
        )
    )


def test_cbp_controller_learns_single_task():
    env = JointReachEnv(n_tasks=4, config=JointReachConfig(n_joints=4))
    ctrl = _controller(env)
    env.set_task(0)
    before = evaluate(ctrl, env, 5, seed=999).mean_return
    train_online(ctrl, env, 8000, seed=0)
    after = evaluate(ctrl, env, 5, seed=999).mean_return
    # Returns are bounded in [0, episode_steps]; a learned MLP policy must lift
    # the greedy policy well above the do-nothing baseline.
    assert after > before + 3.0


def test_stream_ac_core_learns_without_cbp():
    env = JointReachEnv(n_tasks=4, config=JointReachConfig(n_joints=4))
    ctrl = _controller(env, cbp_enabled=False)
    env.set_task(0)
    before = evaluate(ctrl, env, 5, seed=999).mean_return
    train_online(ctrl, env, 8000, seed=0)
    after = evaluate(ctrl, env, 5, seed=999).mean_return
    assert after > before + 3.0


def test_cbp_replaces_units_when_enabled():
    # Aggressive replacement so the mechanism fires quickly in a short test.
    env = JointReachEnv(n_tasks=2, config=JointReachConfig(n_joints=3))
    ctrl = _controller(env, cbp_enabled=True, replacement_rate=0.05, maturity_threshold=10)
    env.set_task(0)
    train_online(ctrl, env, 3000, seed=0)
    # A replaced unit's age is reset to 0, so the youngest hidden unit must be
    # much younger than the total step count if generate-and-test ran.
    youngest = min(int(np.min(np.asarray(age))) for age in ctrl._state.a_age)
    assert youngest < ctrl.steps, "CBP did not replace any actor hidden unit"
    # Utility tracking must have accumulated signal.
    assert float(np.max(np.asarray(ctrl._state.a_util[0]))) > 0.0


def test_no_replacement_when_cbp_disabled():
    env = JointReachEnv(n_tasks=2, config=JointReachConfig(n_joints=3))
    ctrl = _controller(env, cbp_enabled=False, replacement_rate=0.05, maturity_threshold=10)
    env.set_task(0)
    train_online(ctrl, env, 2000, seed=0)
    # No unit is ever replaced, so every hidden unit's age equals the step count.
    youngest = min(int(np.min(np.asarray(age))) for age in ctrl._state.a_age)
    assert youngest == ctrl.steps


def test_state_dict_roundtrip_preserves_policy():
    env = JointReachEnv(n_tasks=2, config=JointReachConfig(n_joints=3))
    ctrl = _controller(env)
    env.set_task(0)
    train_online(ctrl, env, 3000, seed=0)
    obs, _ = env.reset(seed=7)
    a1 = ctrl.act_greedy(obs)
    snap = ctrl.state_dict()

    ctrl2 = _controller(env)
    ctrl2.load_state_dict(snap)
    a2 = ctrl2.act_greedy(obs)
    assert np.allclose(a1, a2, atol=1e-5)


# --------------------------------------------------------------------------- #
# Retention (anti-forgetting): task-gated multi-head over a shared CBP trunk.
# --------------------------------------------------------------------------- #

_EMB = 8


def _mh_controller(
    env: JointReachEnv,
    *,
    mode: str = "frozen",
    n_slots: int = 64,
    trunk_step_scale: float = 0.0,
    trunk_freeze_after: int = 0,
    hidden: tuple[int, ...] = (96,),
) -> AlbertaCBPController:
    return AlbertaCBPController(
        CBPControllerConfig(
            obs_dim=int(env.observation_space.shape[0]),
            action_dim=int(env.action_space.shape[0]),
            hidden_sizes=hidden,
            gamma=0.5,
            actor_step_size=1e-2,
            critic_step_size=2e-2,
            actor_lamda=0.7,
            critic_lamda=0.7,
            log_sigma_init=-1.0,
            normalize=False,  # the EMA normalizer is a shared stat that leaks across tasks
            obgd_kappa=2.0,
            retention=RetentionConfig(
                mode=mode,
                n_slots=n_slots,
                embed_dim=_EMB,
                trunk_step_scale=trunk_step_scale,
                trunk_freeze_after=trunk_freeze_after,
            ),
            seed=0,
        )
    )


def test_gate_routes_distinct_tasks_to_distinct_slots():
    env = JointReachEnv(n_tasks=4, config=JointReachConfig(n_joints=3, embed_dim=_EMB))
    ctrl = _mh_controller(env, mode="multihead", n_slots=256)
    slots = set()
    for task in range(4):
        env.set_task(task)
        obs, _ = env.reset(seed=1)
        slots.add(ctrl.slot_of(obs))
    # Collision-free routing: each task lands on its own head slot.
    assert len(slots) == 4


def test_none_mode_is_single_slot():
    env = JointReachEnv(n_tasks=4, config=JointReachConfig(n_joints=3, embed_dim=_EMB))
    ctrl = _controller(env)  # default retention = none
    for task in range(4):
        env.set_task(task)
        obs, _ = env.reset(seed=1)
        assert ctrl.slot_of(obs) == 0


def test_frozen_multihead_retains_task0_after_task1():
    """The headline retention claim: a frozen-trunk multi-head learner keeps
    task 0 after training task 1, while still learning task 1."""
    env = JointReachEnv(n_tasks=2, config=JointReachConfig(n_joints=3, embed_dim=_EMB))
    ctrl = _mh_controller(env, mode="frozen")

    env.set_task(0)
    train_online(ctrl, env, 6000, seed=0)
    task0_after_t0 = evaluate(ctrl, env, 5, seed=999).mean_return

    env.set_task(1)
    train_online(ctrl, env, 6000, seed=1)
    env.set_task(0)
    task0_after_t1 = evaluate(ctrl, env, 5, seed=999).mean_return
    env.set_task(1)
    task1_after_t1 = evaluate(ctrl, env, 5, seed=999).mean_return

    # Retention: task 0 must survive training task 1 (per-task heads + frozen
    # shared features ⇒ no overwrite). Allow a small eval-noise margin.
    assert task0_after_t1 >= task0_after_t0 - 4.0
    # Capacity: task 1 was actually learned (well above a do-nothing return).
    assert task1_after_t1 > 12.0


def test_multihead_state_dict_roundtrip():
    env = JointReachEnv(n_tasks=2, config=JointReachConfig(n_joints=3, embed_dim=_EMB))
    ctrl = _mh_controller(env, mode="frozen")
    env.set_task(0)
    train_online(ctrl, env, 3000, seed=0)
    env.set_task(1)
    obs, _ = env.reset(seed=7)
    a1 = ctrl.act_greedy(obs)
    snap = ctrl.state_dict()

    ctrl2 = _mh_controller(env, mode="frozen")
    ctrl2.load_state_dict(snap)
    a2 = ctrl2.act_greedy(obs)
    assert np.allclose(a1, a2, atol=1e-5)
